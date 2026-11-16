'use strict';

const assistant = {
  history: [],
  busy: false
};
const ai = id => document.getElementById(id);
const ASSISTANT_API = location.hostname.endsWith('.github.io') ? 'https://dcs-trendweb.onrender.com' : '';

function addAiMessage(text, kind = '') {
  const message = document.createElement('div');
  message.className = `ai-message${kind ? ` ${kind}` : ''}`;
  message.textContent = text;
  ai('aiLog').append(message);
  ai('aiLog').scrollTop = ai('aiLog').scrollHeight;
  return message;
}

function toggleAssistant(open) {
  ai('aiPanel').hidden = !open;
  ai('aiToggle').setAttribute('aria-expanded', String(open));
  if (open) ai('aiInput').focus();
}

ai('aiToggle').addEventListener('click', () => toggleAssistant(ai('aiPanel').hidden));
ai('aiClose').addEventListener('click', () => {
  toggleAssistant(false);
  ai('aiToggle').focus();
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !ai('aiPanel').hidden) {
    toggleAssistant(false);
    ai('aiToggle').focus();
  }
});

ai('aiForm').addEventListener('submit', async event => {
  event.preventDefault();
  const input = ai('aiInput');
  const text = input.value.trim();
  if (!text || assistant.busy) return;

  assistant.history.splice(0, Math.max(0, assistant.history.length - 10));
  assistant.history.push({ role: 'user', content: text });
  addAiMessage(text, 'user');
  input.value = '';
  assistant.busy = true;
  input.disabled = true;
  ai('aiSend').disabled = true;
  const pending = addAiMessage('Thinking...');

  try {
    const response = await fetch(`${ASSISTANT_API}/api/assistant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': sessionStorage.getItem('trendKey') || ''
      },
      body: JSON.stringify({ messages: assistant.history })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
    if (typeof result.reply !== 'string' || !result.reply.trim()) throw new Error('The assistant returned an empty reply.');
    assistant.history.push({ role: 'assistant', content: result.reply });
    pending.remove();
    addAiMessage(result.reply);
  } catch (error) {
    assistant.history.pop();
    pending.remove();
    addAiMessage(error.message || 'The assistant could not respond. Please try again.', 'error');
  } finally {
    assistant.busy = false;
    input.disabled = false;
    ai('aiSend').disabled = false;
    input.focus();
  }
});
