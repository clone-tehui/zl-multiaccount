export function aiChatValue(thread) {
  return thread?.AIchat === 'ON' ? 'ON' : 'off';
}

export function appendAiChat(body, thread) {
  return { ...body, AIchat: aiChatValue(thread) };
}
