/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {AnyNativeEvent} from '../events/PluginModuleType';
import type {FiberRoot} from 'react-reconciler/src/ReactInternalTypes';
import type {Container, SuspenseInstance} from '../client/ReactDOMHostConfig';
import type {DOMEventName} from '../events/DOMEventNames';

// Intentionally not named imports because Rollup would use dynamic dispatch for
// CommonJS interop named imports.
import * as Scheduler from 'scheduler';

import {
  isReplayableDiscreteEvent,
  queueDiscreteEvent,
  hasQueuedDiscreteEvents,
  clearIfContinuousEvent,
  queueIfContinuousEvent,
} from './ReactDOMEventReplaying';
import {
  getNearestMountedFiber,
  getContainerFromFiber,
  getSuspenseInstanceFromFiber,
} from 'react-reconciler/src/ReactFiberTreeReflection';
import {HostRoot, SuspenseComponent} from 'react-reconciler/src/ReactWorkTags';
import {
  type EventSystemFlags,
  IS_CAPTURE_PHASE,
  IS_LEGACY_FB_SUPPORT_MODE,
} from './EventSystemFlags';

import getEventTarget from './getEventTarget';
import {getClosestInstanceFromNode} from '../client/ReactDOMComponentTree';

import {
  enableLegacyFBSupport,
  enableEagerRootListeners,
  decoupleUpdatePriorityFromScheduler,
} from 'shared/ReactFeatureFlags';
import {
  UserBlockingEvent,
  ContinuousEvent,
  DiscreteEvent,
} from 'shared/ReactTypes';
import {getEventPriorityForPluginSystem} from './DOMEventProperties';
import {dispatchEventForPluginEventSystem} from './DOMPluginEventSystem';
import {
  flushDiscreteUpdatesIfNeeded,
  discreteUpdates,
} from './ReactDOMUpdateBatching';
import {
  InputContinuousLanePriority,
  getCurrentUpdateLanePriority,
  setCurrentUpdateLanePriority,
} from 'react-reconciler/src/ReactFiberLane';

const {
  unstable_UserBlockingPriority: UserBlockingPriority,
  unstable_runWithPriority: runWithPriority,
} = Scheduler;

// TODO: can we stop exporting these?
export let _enabled = true;

// This is exported in FB builds for use by legacy FB layer infra.
// We'd like to remove this but it's not clear if this is safe.
export function setEnabled(enabled: ?boolean) {
  _enabled = !!enabled;
}

export function isEnabled() {
  return _enabled;
}

export function createEventListenerWrapper(
  targetContainer: EventTarget,
  domEventName: DOMEventName,
  eventSystemFlags: EventSystemFlags,
): Function {
  return dispatchEvent.bind(
    null,
    domEventName,
    eventSystemFlags,
    targetContainer,
  );
}
// 按照事件名称，划分事件执行的优先级，处理后返回监听函数
export function createEventListenerWrapperWithPriority(
  targetContainer: EventTarget,
  domEventName: DOMEventName,
  eventSystemFlags: EventSystemFlags,  
): Function {
  const eventPriority = getEventPriorityForPluginSystem(domEventName);  // eventPriorities 中获取当前原生事件的优先级
  let listenerWrapper;
  switch (eventPriority) {  // 根据不同的优先级提供不同的监听函数
    case DiscreteEvent:
      listenerWrapper = dispatchDiscreteEvent;
      break;
    case UserBlockingEvent:
      listenerWrapper = dispatchUserBlockingUpdate;
      break;
    case ContinuousEvent:
    default:
      listenerWrapper = dispatchEvent;
      break;
  }
  // 三类监听器的入参其实一样，其函数签名均为：
  // (domEventName: DOMEventName, eventSystemFlags: EventSystemFlags, targetContainer: EventTarget, nativeEvent: AnyNativeEvent) => void
  // 前三个参数由当前函数提供，最后一个参数便是原生监听器会拥有的唯一入参 Event 对象
  return listenerWrapper.bind(
    null,
    domEventName,
    eventSystemFlags,
    targetContainer,
  );
}

function dispatchDiscreteEvent(
  domEventName,
  eventSystemFlags,
  container,
  nativeEvent,
) {
  if (
    !enableLegacyFBSupport ||
    // If we are in Legacy FB support mode, it means we've already
    // flushed for this event and we don't need to do it again.
    (eventSystemFlags & IS_LEGACY_FB_SUPPORT_MODE) === 0
  ) {  // flushDiscreteUpdatesIfNeeded 的作用是清除先前积攒的为执行的离散任务，包括但不限于之前触发的离散事件 和 useEffect 的回调，
    flushDiscreteUpdatesIfNeeded(nativeEvent.timeStamp);  // 主要为了保证当前离散事件所对应的状态时最新的
  }
  discreteUpdates(  // 新建一个离散更新
    dispatchEvent,
    domEventName,
    eventSystemFlags,
    container,
    nativeEvent,
  );
}

function dispatchUserBlockingUpdate(
  domEventName,
  eventSystemFlags,
  container,
  nativeEvent,
) {
  if (decoupleUpdatePriorityFromScheduler) {
    const previousPriority = getCurrentUpdateLanePriority();
    try {
      // TODO: Double wrapping is necessary while we decouple Scheduler priority.
      setCurrentUpdateLanePriority(InputContinuousLanePriority);
      runWithPriority(
        UserBlockingPriority,
        dispatchEvent.bind(
          null,
          domEventName,
          eventSystemFlags,
          container,
          nativeEvent,
        ),
      );
    } finally {
      setCurrentUpdateLanePriority(previousPriority);
    }
  } else {
    runWithPriority(
      UserBlockingPriority,
      dispatchEvent.bind(
        null,
        domEventName,
        eventSystemFlags,
        container,
        nativeEvent,
      ),
    );
  }
}

export function dispatchEvent(
  domEventName: DOMEventName,
  eventSystemFlags: EventSystemFlags,
  targetContainer: EventTarget,
  nativeEvent: AnyNativeEvent,
): void {
  if (!_enabled) {
    return;
  }
  let allowReplay = true;
  if (enableEagerRootListeners) {
    // TODO: replaying capture phase events is currently broken
    // because we used to do it during top-level native bubble handlers
    // but now we use different bubble and capture handlers.
    // In eager mode, we attach capture listeners early, so we need
    // to filter them out until we fix the logic to handle them correctly.
    // This could've been outside the flag but I put it inside to reduce risk.
    allowReplay = (eventSystemFlags & IS_CAPTURE_PHASE) === 0;
  }
  if (
    allowReplay &&
    hasQueuedDiscreteEvents() &&
    isReplayableDiscreteEvent(domEventName)
  ) {
    //如果我们已经有一个离散事件队列，这是另一个离散事件
    //那么无论目标是什么，我们都不能发送它，因为它们
    //需要按顺序发送。
    queueDiscreteEvent(
      null, // Flags that we're not actually blocked on anything as far as we know.
      domEventName,
      eventSystemFlags,
      targetContainer,
      nativeEvent,
    );
    return;
  }

  const blockedOn = attemptToDispatchEvent(
    domEventName,
    eventSystemFlags,
    targetContainer,
    nativeEvent,
  );

  if (blockedOn === null) {
    // We successfully dispatched this event.
    if (allowReplay) {
      clearIfContinuousEvent(domEventName, nativeEvent);
    }
    return;
  }

  if (allowReplay) {
    if (isReplayableDiscreteEvent(domEventName)) {
      // This this to be replayed later once the target is available.
      queueDiscreteEvent(
        blockedOn,
        domEventName,
        eventSystemFlags,
        targetContainer,
        nativeEvent,
      );
      return;
    }
    if (
      queueIfContinuousEvent(
        blockedOn,
        domEventName,
        eventSystemFlags,
        targetContainer,
        nativeEvent,
      )
    ) {
      return;
    }
    // We need to clear only if we didn't queue because
    // queueing is accummulative.
    clearIfContinuousEvent(domEventName, nativeEvent);
  }

  // This is not replayable so we'll invoke it but without a target,
  // in case the event system needs to trace it.
  dispatchEventForPluginEventSystem(
    domEventName,
    eventSystemFlags,
    nativeEvent,
    null,
    targetContainer,
  );
}

// Attempt dispatching an event. Returns a SuspenseInstance or Container if it's blocked.
export function attemptToDispatchEvent(
  domEventName: DOMEventName,
  eventSystemFlags: EventSystemFlags,
  targetContainer: EventTarget,
  nativeEvent: AnyNativeEvent,
): null | Container | SuspenseInstance {
  // TODO: Warn if _enabled is false.
  //将nativeTarget和v-dom中的node对应上
  //react会在每个渲染后的真实dom上的每个HTMLElement都设置一个相同的随机属性名，方便对应和查找
  const nativeEventTarget = getEventTarget(nativeEvent);
  let targetInst = getClosestInstanceFromNode(nativeEventTarget);

  if (targetInst !== null) {
    const nearestMounted = getNearestMountedFiber(targetInst);
    if (nearestMounted === null) {
      // This tree has been unmounted already. Dispatch without a target.
      targetInst = null;
    } else {
      const tag = nearestMounted.tag;
      if (tag === SuspenseComponent) {
        const instance = getSuspenseInstanceFromFiber(nearestMounted);
        if (instance !== null) {
          // Queue the event to be replayed later. Abort dispatching since we
          // don't want this event dispatched twice through the event system.
          // TODO: If this is the first discrete event in the queue. Schedule an increased
          // priority for this boundary.
          return instance;
        }
        // This shouldn't happen, something went wrong but to avoid blocking
        // the whole system, dispatch the event without a target.
        // TODO: Warn.
        targetInst = null;
      } else if (tag === HostRoot) {
        const root: FiberRoot = nearestMounted.stateNode;
        if (root.hydrate) {
          // If this happens during a replay something went wrong and it might block
          // the whole system.
          return getContainerFromFiber(nearestMounted);
        }
        targetInst = null;
      } else if (nearestMounted !== targetInst) {
        // If we get an event (ex: img onload) before committing that
        // component's mount, ignore it for now (that is, treat it as if it was an
        // event on a non-React tree). We might also consider queueing events and
        // dispatching them after the mount.
        targetInst = null;
      }
    }
  }
  dispatchEventForPluginEventSystem(
    domEventName,
    eventSystemFlags,
    nativeEvent,
    targetInst,
    targetContainer,
  );
  // We're not blocked on anything.
  return null;
}
