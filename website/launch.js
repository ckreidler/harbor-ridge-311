import { create } from '@amazon-connect-touchpoint/web';

(function () {
  var config = window.HARBOR_RIDGE_TOUCHPOINT;
  var status = document.getElementById('contact-status');
  var chatButton = document.getElementById('start-chat');
  var callButton = document.getElementById('start-call');
  if (!chatButton || !callButton) return;

  var current = null;
  var mode = null;

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
      var touchpoint = await create({
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
}());
