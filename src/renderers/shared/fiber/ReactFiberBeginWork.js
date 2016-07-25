/**
 * Copyright 2013-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactFiberBeginWork
 * @flow
 */

'use strict';

import type { ReactCoroutine } from 'ReactCoroutine';
import type { Fiber } from 'ReactFiber';
import type { FiberRoot } from 'ReactFiberRoot';
import type { HostConfig } from 'ReactFiberReconciler';
import type { Scheduler } from 'ReactFiberScheduler';
import type { PriorityLevel } from 'ReactPriorityLevel';
import type { PendingState } from 'ReactFiberPendingState';

var {
  reconcileChildFibers,
  reconcileChildFibersInPlace,
  cloneChildFibers,
} = require('ReactChildFiber');
var { LowPriority } = require('ReactPriorityLevel');
var ReactTypeOfWork = require('ReactTypeOfWork');
var {
  IndeterminateComponent,
  FunctionalComponent,
  ClassComponent,
  HostContainer,
  HostComponent,
  CoroutineComponent,
  CoroutineHandlerPhase,
  YieldComponent,
} = ReactTypeOfWork;
var {
  NoWork,
  OffscreenPriority,
} = require('ReactPriorityLevel');
var {
  createPendingState,
  mergePendingState,
} = require('ReactFiberPendingState');

module.exports = function<T, P, I, C>(config : HostConfig<T, P, I, C>, getScheduler: () => Scheduler) {

  function markChildAsProgressed(current, workInProgress, priorityLevel) {
    // We now have clones. Let's store them as the currently progressed work.
    workInProgress.progressedChild = workInProgress.child;
    workInProgress.progressedPriority = priorityLevel;
    if (current) {
      // We also store it on the current. When the alternate swaps in we can
      // continue from this point.
      current.progressedChild = workInProgress.progressedChild;
      current.progressedPriority = workInProgress.progressedPriority;
    }
  }

  function reconcileChildren(current, workInProgress, nextChildren) {
    const priorityLevel = workInProgress.pendingWorkPriority;
    reconcileChildrenAtPriority(current, workInProgress, nextChildren, priorityLevel);
  }

  function reconcileChildrenAtPriority(current, workInProgress, nextChildren, priorityLevel) {
    // At this point any memoization is no longer valid since we'll have changed
    // the children.
    workInProgress.memoizedProps = null;
    if (current && current.child === workInProgress.child) {
      // If the current child is the same as the work in progress, it means that
      // we haven't yet started any work on these children. Therefore, we use
      // the clone algorithm to create a copy of all the current children.
      workInProgress.child = reconcileChildFibers(
        workInProgress,
        workInProgress.child,
        nextChildren,
        priorityLevel
      );
    } else {
      // If, on the other hand, we don't have a current fiber or if it is
      // already using a clone, that means we've already begun some work on this
      // tree and we can continue where we left off by reconciling against the
      // existing children.
      workInProgress.child = reconcileChildFibersInPlace(
        workInProgress,
        workInProgress.child,
        nextChildren,
        priorityLevel
      );
    }
    markChildAsProgressed(current, workInProgress, priorityLevel);
  }

  function updateFunctionalComponent(current, workInProgress) {
    var fn = workInProgress.type;
    var props = workInProgress.pendingProps;

    // TODO: Disable this before release, since it is not part of the public API
    // I use this for testing to compare the relative overhead of classes.
    if (typeof fn.shouldComponentUpdate === 'function') {
      if (workInProgress.memoizedProps !== null) {
        if (!fn.shouldComponentUpdate(workInProgress.memoizedProps, props)) {
          return bailoutOnAlreadyFinishedWork(current, workInProgress);
        }
      }
    }

    var nextChildren = fn(props);
    reconcileChildren(current, workInProgress, nextChildren);
    return workInProgress.child;
  }

  function scheduleUpdate(fiber: Fiber, pendingState: PendingState, priorityLevel : PriorityLevel): void {
    const { scheduleLowPriWork } = getScheduler();
    fiber.pendingState = pendingState;
    while (true) {
      if (fiber.pendingWorkPriority === NoWork ||
          fiber.pendingWorkPriority >= priorityLevel) {
        fiber.pendingWorkPriority = priorityLevel;
      }
      // Duck type root
      if (fiber.stateNode && fiber.stateNode.containerInfo) {
        const root : FiberRoot = (fiber.stateNode : any);
        scheduleLowPriWork(root, priorityLevel);
        return;
      }
      if (!fiber.return) {
        throw new Error('No root!');
      }
      fiber = fiber.return;
    }
  }

  // Class component state updater
  const updater = {
    enqueueSetState(instance, partialState) {
      const fiber = instance._fiber;
      let pendingState = fiber.pendingState;

      // Append to pending state queue
      const nextPendingStateNode = createPendingState(partialState);
      if (pendingState === null) {
        pendingState = nextPendingStateNode;
      } else {
        if (pendingState.tail === null) {
          pendingState.next = nextPendingStateNode;
        } else {
          pendingState.tail.next = nextPendingStateNode;
        }
        pendingState.tail = nextPendingStateNode;
      }

      // Must schedule an update on both alternates, because we don't know tree
      // is current.
      scheduleUpdate(fiber, pendingState, LowPriority);
      if (fiber.alternate) {
        scheduleUpdate(fiber.alternate, pendingState, LowPriority);
      }
    },
  };

  function updateClassComponent(current : ?Fiber, workInProgress : Fiber) {
    // A class component update is the result of either new props or new state.
    // Account for the possibly of missing pending props by falling back to the
    // memoized props.
    var props = workInProgress.pendingProps;
    if (!props && current) {
      props = current.memoizedProps;
    }
    // Compute the state using the memoized state and the pending state queue.
    var pendingState = workInProgress.pendingState;
    var state;
    if (!current) {
      state = mergePendingState(null, pendingState);
    } else {
      state = mergePendingState(current.memoizedState, pendingState);
    }

    var instance = workInProgress.stateNode;
    if (!instance) {
      var ctor = workInProgress.type;
      workInProgress.stateNode = instance = new ctor(props);
      state = instance.state || null;
      // The initial state must be added to the pending state queue in case
      // setState is called before the initial render.
      workInProgress.pendingState = createPendingState(state);
      // The instance needs access to the fiber so that it can schedule updates
      instance._fiber = workInProgress;
      instance.updater = updater;
    } else if (typeof instance.shouldComponentUpdate === 'function') {
      if (workInProgress.memoizedProps !== null) {
        // Reset the props, in case this is a ping-pong case rather than a
        // completed update case. For the completed update case, the instance
        // props will already be the memoizedProps.
        instance.props = workInProgress.memoizedProps;
        instance.state = workInProgress.memoizedState;
        if (!instance.shouldComponentUpdate(props, state)) {
          return bailoutOnAlreadyFinishedWork(current, workInProgress);
        }
      }
    }

    instance.props = props;
    instance.state = state;
    var nextChildren = instance.render();
    reconcileChildren(current, workInProgress, nextChildren);

    return workInProgress.child;
  }

  function updateHostComponent(current, workInProgress) {
    const nextChildren = workInProgress.pendingProps.children;
    if (workInProgress.pendingProps.hidden &&
        workInProgress.pendingWorkPriority !== OffscreenPriority) {
      // If this host component is hidden, we can bail out on the children.
      // We'll rerender the children later at the lower priority.

      // It is unfortunate that we have to do the reconciliation of these
      // children already since that will add them to the tree even though
      // they are not actually done yet. If this is a large set it is also
      // confusing that this takes time to do right now instead of later.

      if (workInProgress.progressedPriority === OffscreenPriority) {
        // If we already made some progress on the offscreen priority before,
        // then we should continue from where we left off.
        workInProgress.child = workInProgress.progressedChild;
      }

      // Reconcile the children and stash them for later work.
      reconcileChildrenAtPriority(current, workInProgress, nextChildren, OffscreenPriority);
      workInProgress.child = current ? current.child : null;
      // Abort and don't process children yet.
      return null;
    } else {
      reconcileChildren(current, workInProgress, nextChildren);
      return workInProgress.child;
    }
  }

  function mountIndeterminateComponent(current, workInProgress) {
    var fn = workInProgress.type;
    var props = workInProgress.pendingProps;
    var value = fn(props);
    if (typeof value === 'object' && value && typeof value.render === 'function') {
      // Proceed under the assumption that this is a class instance
      workInProgress.tag = ClassComponent;
      if (current) {
        current.tag = ClassComponent;
      }
      value = value.render();
    } else {
      // Proceed under the assumption that this is a functional component
      workInProgress.tag = FunctionalComponent;
      if (current) {
        current.tag = FunctionalComponent;
      }
    }
    reconcileChildren(current, workInProgress, value);
    return workInProgress.child;
  }

  function updateCoroutineComponent(current, workInProgress) {
    var coroutine = (workInProgress.pendingProps : ?ReactCoroutine);
    if (!coroutine) {
      throw new Error('Should be resolved by now');
    }
    reconcileChildren(current, workInProgress, coroutine.children);
  }

  /*
  function reuseChildrenEffects(returnFiber : Fiber, firstChild : Fiber) {
    let child = firstChild;
    do {
      // Ensure that the first and last effect of the parent corresponds
      // to the children's first and last effect.
      if (!returnFiber.firstEffect) {
        returnFiber.firstEffect = child.firstEffect;
      }
      if (child.lastEffect) {
        if (returnFiber.lastEffect) {
          returnFiber.lastEffect.nextEffect = child.firstEffect;
        }
        returnFiber.lastEffect = child.lastEffect;
      }
    } while (child = child.sibling);
  }
  */

  function bailoutOnAlreadyFinishedWork(current, workInProgress : Fiber) : ?Fiber {
    const priorityLevel = workInProgress.pendingWorkPriority;

    // TODO: We should ideally be able to bail out early if the children have no
    // more work to do. However, since we don't have a separation of this
    // Fiber's priority and its children yet - we don't know without doing lots
    // of the same work we do anyway. Once we have that separation we can just
    // bail out here if the children has no more work at this priority level.
    // if (workInProgress.priorityOfChildren <= priorityLevel) {
    //   // If there are side-effects in these children that have not yet been
    //   // committed we need to ensure that they get properly transferred up.
    //   if (current && current.child !== workInProgress.child) {
    //     reuseChildrenEffects(workInProgress, child);
    //   }
    //   return null;
    // }

    cloneChildFibers(current, workInProgress);
    markChildAsProgressed(current, workInProgress, priorityLevel);
    return workInProgress.child;
  }

  function bailoutOnLowPriority(current, workInProgress) {
    if (current) {
      workInProgress.child = current.child;
      workInProgress.memoizedProps = current.memoizedProps;
      workInProgress.output = current.output;
    }
    return null;
  }

  function beginWork(current : ?Fiber, workInProgress : Fiber, priorityLevel : PriorityLevel) : ?Fiber {
    if (workInProgress.pendingWorkPriority === NoWork ||
        workInProgress.pendingWorkPriority > priorityLevel) {
      return bailoutOnLowPriority(current, workInProgress);
    }

    if (workInProgress.progressedPriority === priorityLevel) {
      // If we have progressed work on this priority level already, we can
      // proceed this that as the child.
      workInProgress.child = workInProgress.progressedChild;
    }

    if ((workInProgress.pendingProps === null || (
      workInProgress.memoizedProps !== null &&
      workInProgress.pendingProps === workInProgress.memoizedProps &&
      )) &&
      workInProgress.pendingState === null
      ) {
      return bailoutOnAlreadyFinishedWork(current, workInProgress);
    }

    switch (workInProgress.tag) {
      case IndeterminateComponent:
        return mountIndeterminateComponent(current, workInProgress);
      case FunctionalComponent:
        return updateFunctionalComponent(current, workInProgress);
      case ClassComponent:
        return updateClassComponent(current, workInProgress);
      case HostContainer:
        reconcileChildren(current, workInProgress, workInProgress.pendingProps);
        // A yield component is just a placeholder, we can just run through the
        // next one immediately.
        if (workInProgress.child) {
          return beginWork(
            workInProgress.child.alternate,
            workInProgress.child,
            priorityLevel
          );
        }
        return null;
      case HostComponent:
        if (workInProgress.stateNode && config.beginUpdate) {
          config.beginUpdate(workInProgress.stateNode);
        }
        return updateHostComponent(current, workInProgress);
      case CoroutineHandlerPhase:
        // This is a restart. Reset the tag to the initial phase.
        workInProgress.tag = CoroutineComponent;
        // Intentionally fall through since this is now the same.
      case CoroutineComponent:
        updateCoroutineComponent(current, workInProgress);
        // This doesn't take arbitrary time so we could synchronously just begin
        // eagerly do the work of workInProgress.child as an optimization.
        if (workInProgress.child) {
          return beginWork(
            workInProgress.child.alternate,
            workInProgress.child,
            priorityLevel
          );
        }
        return workInProgress.child;
      case YieldComponent:
        // A yield component is just a placeholder, we can just run through the
        // next one immediately.
        if (workInProgress.sibling) {
          return beginWork(
            workInProgress.sibling.alternate,
            workInProgress.sibling,
            priorityLevel
          );
        }
        return null;
      default:
        throw new Error('Unknown unit of work tag');
    }
  }

  return {
    beginWork,
  };

};