const apiKey = process.env.OPENAI_API_KEY || '';
export const openAIModel = process.env.OPENAI_MODEL || 'gpt-6-astra';
export const isOpenAIConfigured = Boolean(apiKey);

function extractOutputText(response) {
  if (typeof response.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }

  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === 'output_text' && typeof content.text === 'string') {
        return content.text.trim();
      }
    }
  }

  return '';
}

export async function createStructuredResponse({
  name,
  schema,
  instructions,
  input,
}) {
  if (!apiKey) {
    const error = new Error('OPENAI_API_KEY is not configured');
    error.code = 'openai_not_configured';
    throw error;
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: openAIModel,
      reasoning: { effort: 'low' },
      instructions,
      input,
      text: {
        format: {
          type: 'json_schema',
          name,
          strict: true,
          schema,
        },
      },
    }),
    signal: AbortSignal.timeout(120000),
  });

  const payload = await response.json();

  if (!response.ok) {
    const error = new Error(
      payload?.error?.message || `OpenAI API returned HTTP ${response.status}`,
    );
    error.code = 'openai_request_failed';
    error.status = response.status;
    error.data = payload;
    throw error;
  }

  const outputText = extractOutputText(payload);
  if (!outputText) {
    const error = new Error('OpenAI response did not contain output text');
    error.code = 'openai_empty_response';
    throw error;
  }

  try {
    return JSON.parse(outputText);
  } catch (cause) {
    const error = new Error('OpenAI structured response was not valid JSON');
    error.code = 'openai_invalid_json';
    error.cause = cause;
    throw error;
  }
}
