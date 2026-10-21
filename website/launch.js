(function () {
  var config = window.HARBOR_RIDGE_TOUCHPOINT;
  var status = document.getElementById('contact-status');
  var chatButton = document.getElementById('start-chat');
  var callButton = document.getElementById('start-call');
  if (!chatButton || !callButton) return;

  var current = null;
  var mode = null;
  var activeVoiceStop = null;
  var nativeFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;

  if (nativeFetch) {
    window.fetch = function (input, init) {
      var result = nativeFetch(input, init);
      var url = typeof input === 'string' ? input : (input && input.url);
      if (config && url === config.voiceEndpoint && result && typeof result.then === 'function') {
        result.then(function (response) {
          if (!response || !response.ok || typeof response.clone !== 'function') return;
          var cloned = response.clone();
          if (!cloned || typeof cloned.json !== 'function') return;
          cloned.json().then(function (body) {
            if (!body || typeof body.ContactId !== 'string' || typeof body.StopToken !== 'string') return;
            if (body.ContactId === '' || body.StopToken === '') return;
            activeVoiceStop = { contactId: body.ContactId, stopToken: body.StopToken };
          }).catch(function () {});
        }).catch(function () {});
      }
      return result;
    };
  }

  function stopVoiceOnLeave() {
    var pending = activeVoiceStop;
    var endpoint = config && config.voiceStopEndpoint;
    if (!pending || !endpoint) return;
    var body = JSON.stringify({ ContactId: pending.contactId, StopToken: pending.stopToken });
    var queued = false;
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      try {
        queued = navigator.sendBeacon(endpoint, body) === true;
      } catch (error) {
        queued = false;
      }
    }
    if (!queued && nativeFetch) {
      try {
        nativeFetch(endpoint, {
          method: 'POST',
          body: body,
          keepalive: true,
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        });
        queued = true;
      } catch (error) {
        queued = false;
      }
    }
    if (queued) activeVoiceStop = null;
  }

  function setStatus(text) {
    if (!status) return;
    status.hidden = !text;
    status.textContent = text || '';
  }

  function setPressed(nextMode) {
    chatButton.setAttribute('aria-pressed', nextMode === 'chat' ? 'true' : 'false');
    callButton.setAttribute('aria-pressed', nextMode === 'call' ? 'true' : 'false');
  }

  async function open(nextMode) {
    if (chatButton.disabled) return;
    if (!config || !config.chatEndpoint || !config.voiceEndpoint) {
      setStatus('Chat and calling are not configured on this page yet.');
      return;
    }
    var sdk = window.amazonConnectTouchpoint;
    if (!sdk || typeof sdk.create !== 'function') {
      setStatus('The contact widget did not load.');
      return;
    }
    if (current && mode === nextMode) {
      current.expanded = true;
      return;
    }

    chatButton.disabled = true;
    callButton.disabled = true;
    setStatus(nextMode === 'chat' ? 'Opening chat…' : 'Opening the call…');
    try {
      if (current) {
        try {
          current.conversationHandler.endConversation();
        } catch (error) {
        }
        current.teardown();
        current = null;
        mode = null;
      }
      var touchpoint = await sdk.create({
        config: {
          chatEndpoint: config.chatEndpoint,
          voiceEndpoint: config.voiceEndpoint,
          instanceId: config.instanceId,
          contactFlowId: config.contactFlowId,
          region: config.region,
          participantDisplayName: 'Harbor Ridge visitor',
        },
        input: nextMode === 'chat' ? 'text' : 'voiceMini',
        colorMode: 'light',
        windowSize: 'floating',
        chatMode: true,
        theme: {
          accent: '#0f6e6b',
          fontFamily: '"Segoe UI", "Helvetica Neue", sans-serif',
        },
        userMessageBubble: true,
        agentMessageBubble: true,
        userMessageBubbleStyle: {
          backgroundColor: '#0f6e6b',
          color: '#ffffff',
          borderRadius: '16px',
        },
        agentMessageBubbleStyle: {
          backgroundColor: '#e7f2f1',
          color: '#1c2b33',
          borderRadius: '16px',
        },
      });
      current = touchpoint;
      mode = nextMode;
      setPressed(nextMode);
      touchpoint.expanded = true;
      setStatus('');
    } catch (error) {
      setPressed(null);
      setStatus('Could not open the contact widget.');
    } finally {
      chatButton.disabled = false;
      callButton.disabled = false;
    }
  }

  chatButton.addEventListener('click', function () { open('chat'); });
  callButton.addEventListener('click', function () { open('call'); });
  window.addEventListener('pagehide', stopVoiceOnLeave);
}());
