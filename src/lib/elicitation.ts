import {
  ELICITATION_EXTENSION_KEY,
  ELICITATION_EXTENSION_URI,
  type A2aMessage,
  type ElicitationProperty,
  type ElicitationRequest,
  type ElicitationResponse,
} from './a2a-types.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const propertyOf = (value: unknown): ElicitationProperty | undefined => {
  if (!isRecord(value) || !['string', 'number', 'integer', 'boolean'].includes(String(value.type))) return undefined;
  if (value.enum !== undefined && (value.type !== 'string' || !Array.isArray(value.enum) || !value.enum.every((item) => typeof item === 'string'))) return undefined;
  if (value.enumNames !== undefined && (!Array.isArray(value.enumNames) || !value.enumNames.every((item) => typeof item === 'string'))) return undefined;
  if (Array.isArray(value.enum) && Array.isArray(value.enumNames) && value.enum.length !== value.enumNames.length) return undefined;
  return value as unknown as ElicitationProperty;
};

export const readElicitation = (message: A2aMessage | undefined): ElicitationRequest | undefined => {
  if (!message?.extensions?.includes(ELICITATION_EXTENSION_URI)) return undefined;
  for (const part of message.parts) {
    if (!isRecord(part.data)) continue;
    const request = part.data[ELICITATION_EXTENSION_KEY];
    if (!isRecord(request) || typeof request.message !== 'string' || !isRecord(request.requestedSchema)) continue;
    const schema = request.requestedSchema;
    if (schema.type !== 'object' || !isRecord(schema.properties)) continue;
    const properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, value]) => [name, propertyOf(value)]),
    );
    if (Object.values(properties).some((value) => value === undefined)) continue;
    if (
      schema.required !== undefined &&
      (!Array.isArray(schema.required) ||
        !schema.required.every((name) => typeof name === 'string' && Object.hasOwn(properties, name)))
    ) continue;
    return {
      message: request.message,
      requestedSchema: {
        type: 'object',
        properties: properties as Record<string, ElicitationProperty>,
        ...(schema.required ? { required: schema.required as string[] } : {}),
      },
    };
  }
  return undefined;
};

const numberValue = (name: string, raw: FormDataEntryValue | null, property: ElicitationProperty): number => {
  const value = Number(String(raw ?? ''));
  if (!Number.isFinite(value) || (property.type === 'integer' && !Number.isInteger(value))) {
    throw new Error(`${name} must be a valid ${property.type}`);
  }
  if (property.minimum !== undefined && value < property.minimum) throw new Error(`${name} must be at least ${property.minimum}`);
  if (property.maximum !== undefined && value > property.maximum) throw new Error(`${name} must be at most ${property.maximum}`);
  return value;
};

export const responseFromForm = (form: FormData, request: ElicitationRequest): ElicitationResponse => {
  const action = String(form.get('elicitationAction') ?? 'accept');
  if (action === 'decline' || action === 'cancel') return { action };
  if (action !== 'accept') throw new Error('invalid elicitation action');
  const required = new Set(request.requestedSchema.required ?? []);
  const content: Record<string, string | number | boolean> = {};
  for (const [name, property] of Object.entries(request.requestedSchema.properties)) {
    const raw = form.get(`field:${name}`);
    if (property.type === 'boolean') {
      content[name] = raw === 'true';
      continue;
    }
    const text = String(raw ?? '').trim();
    if (!text) {
      if (required.has(name)) throw new Error(`${property.title ?? name} is required`);
      continue;
    }
    if (property.enum && !property.enum.includes(text)) throw new Error(`${property.title ?? name} is not an allowed choice`);
    if (property.minLength !== undefined && text.length < property.minLength) throw new Error(`${property.title ?? name} is too short`);
    if (property.maxLength !== undefined && text.length > property.maxLength) throw new Error(`${property.title ?? name} is too long`);
    content[name] = property.type === 'string' ? text : numberValue(property.title ?? name, raw, property);
  }
  if (
    Object.values(content).includes('other') &&
    request.requestedSchema.properties.other?.type === 'string' &&
    typeof content.other !== 'string'
  ) {
    throw new Error('Other is required when the Other choice is selected');
  }
  return { action: 'accept', content };
};

export const elicitationText = (response: ElicitationResponse): string =>
  response.action === 'accept'
    ? `Accepted requested input: ${JSON.stringify(response.content)}`
    : response.action === 'decline'
      ? 'Declined the requested input.'
      : 'Canceled the requested input.';
