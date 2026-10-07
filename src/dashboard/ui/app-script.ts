/**
 * The dashboard client, served verbatim as one classic script (no import/export). Vanilla JS with
 * string concatenation only: this is a String.raw template, so it must hold no backtick and no
 * dollar-brace sequence.
 */
export const APP_SCRIPT: string = String.raw`(function () {
  'use strict';

  var MAX_ALERTS = 20;
  var BACKOFF_START_MS = 1000;
  var BACKOFF_CAP_MS = 30000;

  function formatMs(ns) {
    return (ns / 1e6).toFixed(1) + ' ms';
  }

  function formatMiB(bytes) {
    return (bytes / 1048576).toFixed(1) + ' MiB';
  }

  function formatTime(epochMs) {
    try {
      return new Date(epochMs).toISOString();
    } catch (error) {
      return String(epochMs);
    }
  }

  /** Splits complete SSE frames out of the buffer; returns the frames and the unfinished rest. */
  function splitFrames(buffer) {
    var frames = [];
    var index = buffer.indexOf('\n\n');
    while (index !== -1) {
      frames.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 2);
      index = buffer.indexOf('\n\n');
    }
    return { frames: frames, rest: buffer };
  }

  /** One frame to { event, data }; a frame of only comment lines (the heartbeat) gives null. */
  function parseFrame(frame) {
    var event = 'message';
    var dataLines = [];
    var lines = frame.split('\n');
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i];
      if (line === '' || line.charAt(0) === ':') {
        continue;
      }
      var colon = line.indexOf(':');
      var field = colon === -1 ? line : line.slice(0, colon);
      var value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.charAt(0) === ' ') {
        value = value.slice(1);
      }
      if (field === 'event') {
        event = value;
      } else if (field === 'data') {
        dataLines.push(value);
      }
    }
    if (dataLines.length === 0) {
      return null;
    }
    return { event: event, data: dataLines.join('\n') };
  }

  function init() {
    var meta = document.querySelector('meta[name="argus-events"]');
    var statusEl = document.getElementById('status');
    var lagEl = document.getElementById('lag');
    var memoryEl = document.getElementById('memory');
    var gcEl = document.getElementById('gc');
    var alertsEl = document.getElementById('alerts');
    var emptyEl = document.getElementById('alerts-empty');

    if (!meta || !statusEl || !lagEl || !memoryEl || !gcEl || !alertsEl || !emptyEl) {
      console.error('argus dashboard: the page is missing an expected element');
      if (statusEl) {
        statusEl.textContent = 'error: the page is incomplete';
        statusEl.className = 'status-error';
      }
      return;
    }

    var eventsUrl = new URL(meta.getAttribute('content') || 'events', document.baseURI);
    var backoffMs = BACKOFF_START_MS;
    var retryTimer = null;

    function setStatus(text, kind) {
      statusEl.textContent = text;
      statusEl.className = 'status-' + kind;
    }

    function renderWindow(w) {
      lagEl.textContent = 'p99 ' + formatMs(w.eventLoop.p99) + ' · max ' + formatMs(w.eventLoop.max);
      memoryEl.textContent =
        'heap ' + formatMiB(w.memory.heapUsedLast) + ' · rss ' + formatMiB(w.memory.rssLast);
      gcEl.textContent =
        w.gc.count +
        ' collections · ' +
        formatMs(w.gc.totalPause) +
        ' total pause · ' +
        formatMs(w.gc.maxPause) +
        ' max';
    }

    function addAlert(a) {
      var item = document.createElement('li');
      item.textContent =
        a.ruleId +
        ' ' +
        a.state +
        ' — ' +
        a.metric +
        ' ' +
        a.comparison +
        ' ' +
        a.threshold +
        ' (observed ' +
        a.observed +
        ') ' +
        formatTime(a.windowEnd);
      alertsEl.insertBefore(item, alertsEl.firstChild);
      while (alertsEl.children.length > MAX_ALERTS) {
        alertsEl.removeChild(alertsEl.lastChild);
      }
      emptyEl.hidden = true;
    }

    function clearAlerts() {
      while (alertsEl.firstChild) {
        alertsEl.removeChild(alertsEl.firstChild);
      }
      emptyEl.hidden = false;
    }

    function handleFrame(frame) {
      var parsed = parseFrame(frame);
      if (parsed === null) {
        return;
      }
      if (parsed.event !== 'window' && parsed.event !== 'alert') {
        return;
      }
      try {
        var payload = JSON.parse(parsed.data);
        if (parsed.event === 'window') {
          renderWindow(payload);
        } else {
          addAlert(payload);
        }
      } catch (error) {
        console.error('argus dashboard: bad ' + parsed.event + ' event', error);
        setStatus('error: bad ' + parsed.event + ' event', 'error');
      }
    }

    function scheduleRetry() {
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
      }
      retryTimer = setTimeout(function () {
        retryTimer = null;
        connect();
      }, backoffMs);
      backoffMs = Math.min(backoffMs * 2, BACKOFF_CAP_MS);
    }

    function onDisconnect(error) {
      if (error) {
        console.error('argus dashboard: stream error', error);
      }
      setStatus('reconnecting', 'reconnecting');
      scheduleRetry();
    }

    function readLoop(reader, decoder, buffer) {
      return reader.read().then(function (result) {
        if (result.done) {
          return null;
        }
        buffer += decoder.decode(result.value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        var split = splitFrames(buffer);
        for (var i = 0; i < split.frames.length; i += 1) {
          handleFrame(split.frames[i]);
        }
        return readLoop(reader, decoder, split.rest);
      });
    }

    function connect() {
      setStatus('connecting', 'reconnecting');
      fetch(eventsUrl.href, {
        headers: { accept: 'text/event-stream' },
        cache: 'no-store',
        credentials: 'same-origin',
      })
        .then(function (response) {
          if (response.status === 401 || response.status === 403) {
            setStatus('unauthorized — open the dashboard with ?token=…', 'error');
            return null;
          }
          if (!response.ok || !response.body) {
            setStatus('error: HTTP ' + response.status, 'error');
            scheduleRetry();
            return null;
          }
          backoffMs = BACKOFF_START_MS;
          clearAlerts();
          setStatus('live', 'live');
          return readLoop(response.body.getReader(), new TextDecoder(), '').then(function () {
            onDisconnect(null);
          });
        })
        .catch(onDisconnect);
    }

    connect();
  }

  if (document.readyState !== 'loading') {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
`;
