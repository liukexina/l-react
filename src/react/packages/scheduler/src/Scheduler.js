/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* eslint-disable no-var */

import {
  enableSchedulerDebugging,
  enableProfiling,
} from './SchedulerFeatureFlags';
import {
  requestHostCallback,
  requestHostTimeout,
  cancelHostTimeout,
  shouldYieldToHost,
  getCurrentTime,
  forceFrameRate,
  requestPaint,
} from './SchedulerHostConfig';
import {push, pop, peek} from './SchedulerMinHeap';

// TODO: Use symbols?
import {
  ImmediatePriority,
  UserBlockingPriority,
  NormalPriority,
  LowPriority,
  IdlePriority,
} from './SchedulerPriorities';
import {
  sharedProfilingBuffer,
  markTaskRun,
  markTaskYield,
  markTaskCompleted,
  markTaskCanceled,
  markTaskErrored,
  markSchedulerSuspended,
  markSchedulerUnsuspended,
  markTaskStart,
  stopLoggingProfilingEvents,
  startLoggingProfilingEvents,
} from './SchedulerProfiling';

// Max 31 bit integer. The max integer size in V8 for 32-bit systems.
// Math.pow(2, 30) - 1
// 0b111111111111111111111111111111
var maxSigned31BitInt = 1073741823;

// 不同优先级对应的不同的任务过期时间间隔
// Times out immediately
var IMMEDIATE_PRIORITY_TIMEOUT = -1;
// Eventually times out
var USER_BLOCKING_PRIORITY_TIMEOUT = 250;
var NORMAL_PRIORITY_TIMEOUT = 5000;
var LOW_PRIORITY_TIMEOUT = 10000;
// Never times out
var IDLE_PRIORITY_TIMEOUT = maxSigned31BitInt;

// Tasks are stored on a min heap
var taskQueue = [];
var timerQueue = [];

// Incrementing id counter. Used to maintain insertion order.
var taskIdCounter = 1;

// Pausing the scheduler is useful for debugging.
var isSchedulerPaused = false;

var currentTask = null;
var currentPriorityLevel = NormalPriority;

// This is set while performing work, to prevent re-entrancy.
var isPerformingWork = false;

var isHostCallbackScheduled = false;
var isHostTimeoutScheduled = false;

function advanceTimers(currentTime) {
  // Check for tasks that are no longer delayed and add them to the queue.
  let timer = peek(timerQueue);
  while (timer !== null) {
    if (timer.callback === null) {
      // Timer was cancelled.
      pop(timerQueue);
    } else if (timer.startTime <= currentTime) {
      // Timer fired. Transfer to the task queue.
      pop(timerQueue);
      timer.sortIndex = timer.expirationTime;
      push(taskQueue, timer);
      if (enableProfiling) {
        markTaskStart(timer, currentTime);
        timer.isQueued = true;
      }
    } else {
      // Remaining timers are pending.
      return;
    }
    timer = peek(timerQueue);
  }
}

function handleTimeout(currentTime) {
  isHostTimeoutScheduled = false;
  advanceTimers(currentTime);  // 检查timerQueue队列中过期的任务，放到taskQueue中。

  if (!isHostCallbackScheduled) {  // 检查是否已经开始调度，
    if (peek(taskQueue) !== null) {  // 如尚未调度，检查taskQueue中是否已经有任务
      // 如果有，而且现在是空闲的，说明之前的advanceTimers已经将过期任务放到了taskQueue
      // 那么现在立即开始调度，执行任务

      isHostCallbackScheduled = true;
      requestHostCallback(flushWork);
    } else {
      // 如果没有，而且现在是空闲的，说明之前的advanceTimers并没有检查到timerQueue中有过期任务
      // 那么再次调用requestHostTimeout重复这一过程。

      const firstTimer = peek(timerQueue);
      if (firstTimer !== null) {
        requestHostTimeout(handleTimeout, firstTimer.startTime - currentTime);
      }
    }
  }
}

function flushWork(hasTimeRemaining, initialTime) {
  if (enableProfiling) {
    markSchedulerUnsuspended(initialTime);
  }

  // We'll need a host callback the next time work is scheduled.
  isHostCallbackScheduled = false;
  if (isHostTimeoutScheduled) {
    // We scheduled a timeout but it's no longer needed. Cancel it.
    isHostTimeoutScheduled = false;
    cancelHostTimeout();
  }

  isPerformingWork = true;
  const previousPriorityLevel = currentPriorityLevel;
  try {
    if (enableProfiling) {
      try {
        return workLoop(hasTimeRemaining, initialTime);
      } catch (error) {
        if (currentTask !== null) {
          const currentTime = getCurrentTime();
          markTaskErrored(currentTask, currentTime);
          currentTask.isQueued = false;
        }
        throw error;
      }
    } else {
      // No catch in prod code path.
      return workLoop(hasTimeRemaining, initialTime);
    }
  } finally {
    currentTask = null;
    currentPriorityLevel = previousPriorityLevel;
    isPerformingWork = false;
    if (enableProfiling) {
      const currentTime = getCurrentTime();
      markSchedulerSuspended(currentTime);
    }
  }
}

// workLoop中可以分为两大部分：循环taskQueue执行任务 和 任务状态的判断。
// workLoop是通过判断任务函数的返回值去识别任务的完成状态的。
function workLoop(hasTimeRemaining, initialTime) {
  let currentTime = initialTime;

  // 开始执行前检查一下timerQueue中的过期任务，
  // 放到taskQueue中
  advanceTimers(currentTime);  
  currentTask = peek(taskQueue);  // 获取taskQueue中排在最前面的任务
  
  // 循环taskQueue，执行任务
  while (
    currentTask !== null &&
    !(enableSchedulerDebugging && isSchedulerPaused)
  ) {
    if (
      currentTask.expirationTime > currentTime &&  // 任务并未过期，但已经没有剩余时间
      (!hasTimeRemaining || shouldYieldToHost())  // 由于hasTimeRemaining一直为true，这与MessageChannel作为宏任务的执行时机有关，我们忽略这个判断条件，只看时间片
    ) {  // shouldYieldToHost：应该让出执行权给主线程（时间片的限制） 即为检查5毫秒是否到期的条件
      // 时间片的限制，中断任务
      break;
    }

    // 执行任务 ---------------------------------------------------
    // 获取任务的执行函数，这个callback就是React传给Scheduler
    // 的任务。例如：performConcurrentWorkOnRoot
    const callback = currentTask.callback;
    if (typeof callback === 'function') { // 如果执行函数为function，说明还有任务可做，调用它
      currentTask.callback = null;
      currentPriorityLevel = currentTask.priorityLevel;  // 获取任务的优先级
      const didUserCallbackTimeout = currentTask.expirationTime <= currentTime;  // 任务是否过期
      markTaskRun(currentTask, currentTime);
      const continuationCallback = callback(didUserCallbackTimeout);  // 获取任务函数的执行结果
      currentTime = getCurrentTime();
      if (typeof continuationCallback === 'function') {

        // 检查callback的执行结果返回的是不是函数，如果返回的是函数，则将这个函数作为当前任务新的回调。
        // concurrent模式下，callback是performConcurrentWorkOnRoot，其内部根据当前调度的任务
        // 是否相同，来决定是否返回自身，如果相同，则说明还有任务没做完，返回自身，其作为新的callback
        // 被放到当前的task上。while循环完成一次之后，检查shouldYieldToHost，如果需要让出执行权，
        // 则中断循环，走到下方，判断currentTask不为null，返回true，说明还有任务，回到performWorkUntilDeadline
        // 中，判断还有任务，继续port.postMessage(null)，调用监听函数performWorkUntilDeadline（执行者），
        // 继续调用workLoop行任务

        // 将返回值继续赋值给currentTask.callback，为得是下一次能够继续执行callback，
        // 获取它的返回值，继续判断任务是否完成。
        currentTask.callback = continuationCallback;
        markTaskYield(currentTask, currentTime);
      } else {
        if (enableProfiling) {
          markTaskCompleted(currentTask, currentTime);
          currentTask.isQueued = false;
        }
        if (currentTask === peek(taskQueue)) {
          pop(taskQueue);
        }
      }
      advanceTimers(currentTime);
    } else {

      // 如果callback为null，代表任务执行完毕，将任务出队
      pop(taskQueue);
    }

    // 从taskQueue中继续获取任务，如果上一个任务未完成，那么它将不会
    // 被从队列剔除，所以获取到的currentTask还是上一个任务，会继续
    // 去执行它

    // 获取下一个任务，继续循环
    currentTask = peek(taskQueue);
  }
  // Return whether there's additional work

  // return 的结果会作为 performWorkUntilDeadline
  // 中判断是否还需要再次发起调度的依据

  if (currentTask !== null) {

    // 如果currentTask不为空，说明是时间片的限制导致了任务中断
    // return 一个 true告诉外部，此时任务还未执行完，还有任务，
    // 翻译成英文就是hasMoreWork
    return true;  // 此处是恢复任务的关键
  } else {

    // 如果currentTask为空，说明taskQueue队列中的任务已经都
    // 执行完了，然后从timerQueue中找任务，调用requestHostTimeout
    // 去把task放到taskQueue中，到时会再次发起调度，但是这次，
    // 会先return false，告诉外部当前的taskQueue已经清空，
    // 先停止执行任务，也就是终止任务调度
    const firstTimer = peek(timerQueue);
    if (firstTimer !== null) {
      requestHostTimeout(handleTimeout, firstTimer.startTime - currentTime);
    }
    return false;  // 让外部终止本次调度
  }
}

function unstable_runWithPriority(priorityLevel, eventHandler) {
  switch (priorityLevel) {
    case ImmediatePriority:
    case UserBlockingPriority:
    case NormalPriority:
    case LowPriority:
    case IdlePriority:
      break;
    default:
      priorityLevel = NormalPriority;
  }

  var previousPriorityLevel = currentPriorityLevel;
  currentPriorityLevel = priorityLevel;

  try {
    return eventHandler();
  } finally {
    currentPriorityLevel = previousPriorityLevel;
  }
}

function unstable_next(eventHandler) {
  var priorityLevel;
  switch (currentPriorityLevel) {
    case ImmediatePriority:
    case UserBlockingPriority:
    case NormalPriority:
      // Shift down to normal priority
      priorityLevel = NormalPriority;
      break;
    default:
      // Anything lower than normal priority should remain at the current level.
      priorityLevel = currentPriorityLevel;
      break;
  }

  var previousPriorityLevel = currentPriorityLevel;
  currentPriorityLevel = priorityLevel;

  try {
    return eventHandler();
  } finally {
    currentPriorityLevel = previousPriorityLevel;
  }
}

function unstable_wrapCallback(callback) {
  var parentPriorityLevel = currentPriorityLevel;
  return function() {
    // This is a fork of runWithPriority, inlined for performance.
    var previousPriorityLevel = currentPriorityLevel;
    currentPriorityLevel = parentPriorityLevel;

    try {
      return callback.apply(this, arguments);
    } finally {
      currentPriorityLevel = previousPriorityLevel;
    }
  };
}

function unstable_scheduleCallback(priorityLevel, callback, options) {
  var currentTime = getCurrentTime();

  var startTime;
  if (typeof options === 'object' && options !== null) {
    var delay = options.delay;
    if (typeof delay === 'number' && delay > 0) {
      startTime = currentTime + delay;
    } else {
      startTime = currentTime;
    }
  } else {
    startTime = currentTime;
  }

  // 计算timeout
  var timeout;
  switch (priorityLevel) {
    case ImmediatePriority:
      timeout = IMMEDIATE_PRIORITY_TIMEOUT; // -1
      break;
    case UserBlockingPriority:
      timeout = USER_BLOCKING_PRIORITY_TIMEOUT;  // 250
      break;
    case IdlePriority:
      timeout = IDLE_PRIORITY_TIMEOUT;  // 1073741823 ms
      break;
    case LowPriority:
      timeout = LOW_PRIORITY_TIMEOUT;  // 10000
      break;
    case NormalPriority:
    default:
      timeout = NORMAL_PRIORITY_TIMEOUT;  // 5000
      break;
  }

  // 计算任务的过期时间，任务开始时间 + timeout
  // 若是立即执行的优先级（ImmediatePriority），
  // 它的过期时间是startTime - 1，意味着立刻就过期
  var expirationTime = startTime + timeout;

  // 创建调度任务
  var newTask = {
    id: taskIdCounter++,
    callback,  // 真正的任务函数，重点
    priorityLevel, // 任务优先级
    startTime, // 任务开始的时间，表示任务何时才能执行
    expirationTime, // 任务的过期时间
    sortIndex: -1, // 在小顶堆队列中排序的依据
  };
  if (enableProfiling) {
    newTask.isQueued = false;
  }
  
  // 如果任务未过期，则将 newTask 放入timerQueue， 调用requestHostTimeout，
  // 目的是在timerQueue中排在最前面的任务的开始时间的时间点检查任务是否过期，
  // 过期则立刻将任务加入taskQueue，开始调度
  
  // 如果任务已过期，则将 newTask 放入taskQueue，调用requestHostCallback，
  // 开始调度执行taskQueue中的任务

  // 任务过期与否的处理。

  if (startTime > currentTime) {
    // This is a delayed task. // 任务未过期，以开始时间作为timerQueue排序的依据
    newTask.sortIndex = startTime;
    push(timerQueue, newTask);
    if (peek(taskQueue) === null && newTask === peek(timerQueue)) {
      // All tasks are delayed, and this is the task with the earliest delay.
      // 如果现在taskQueue中没有任务，并且当前的任务是timerQueue中排名最靠前的那一个
      // 那么需要检查timerQueue中有没有需要放到taskQueue中的任务，这一步通过调用
      // requestHostTimeout实现

      if (isHostTimeoutScheduled) {
        // 因为即将调度一个requestHostTimeout，所以如果之前已经调度了，那么取消掉
        // Cancel an existing timeout.
        cancelHostTimeout();
      } else {
        isHostTimeoutScheduled = true;
      }
      // Schedule a timeout.
      // 调用requestHostTimeout实现任务的转移，开启调度
      requestHostTimeout(handleTimeout, startTime - currentTime);
    }
  } else {
   // 任务已经过期，以过期时间作为taskQueue排序的依据

    newTask.sortIndex = expirationTime;
    push(taskQueue, newTask);
    if (enableProfiling) {
      markTaskStart(newTask, currentTime);
      newTask.isQueued = true;
    }
    // Schedule a host callback, if needed. If we're already performing work,
    // wait until the next time we yield.
    // 开始执行任务，使用flushWork去执行taskQueue
    if (!isHostCallbackScheduled && !isPerformingWork) {
      isHostCallbackScheduled = true;
      requestHostCallback(flushWork);   // 开始进行调度
    }
  }

  return newTask;
}

function unstable_pauseExecution() {
  isSchedulerPaused = true;
}

function unstable_continueExecution() {
  isSchedulerPaused = false;
  if (!isHostCallbackScheduled && !isPerformingWork) {
    isHostCallbackScheduled = true;
    requestHostCallback(flushWork);
  }
}

function unstable_getFirstCallbackNode() {
  return peek(taskQueue);
}

function unstable_cancelCallback(task) {
  if (enableProfiling) {
    if (task.isQueued) {
      const currentTime = getCurrentTime();
      markTaskCanceled(task, currentTime);
      task.isQueued = false;
    }
  }

  // Null out the callback to indicate the task has been canceled. (Can't
  // remove from the queue because you can't remove arbitrary nodes from an
  // array based heap, only the first one.)
  task.callback = null;
}

function unstable_getCurrentPriorityLevel() {
  return currentPriorityLevel;
}

const unstable_requestPaint = requestPaint;

export {
  ImmediatePriority as unstable_ImmediatePriority,
  UserBlockingPriority as unstable_UserBlockingPriority,
  NormalPriority as unstable_NormalPriority,
  IdlePriority as unstable_IdlePriority,
  LowPriority as unstable_LowPriority,
  unstable_runWithPriority,
  unstable_next,
  unstable_scheduleCallback,
  unstable_cancelCallback,
  unstable_wrapCallback,
  unstable_getCurrentPriorityLevel,
  shouldYieldToHost as unstable_shouldYield,
  unstable_requestPaint,
  unstable_continueExecution,
  unstable_pauseExecution,
  unstable_getFirstCallbackNode,
  getCurrentTime as unstable_now,
  forceFrameRate as unstable_forceFrameRate,
};

export const unstable_Profiling = enableProfiling
  ? {
      startLoggingProfilingEvents,
      stopLoggingProfilingEvents,
      sharedProfilingBuffer,
    }
  : null;
