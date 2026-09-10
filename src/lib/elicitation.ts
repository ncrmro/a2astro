import {
  ELICITATION_EXTENSION_KEY,
  ELICITATION_EXTENSION_URI,
  type A2aMessage,
  type ElicitationProperty,
  type ElicitationRequest,
  type ElicitationResponse,
  type A2aPart,
} from './a2a-types.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const COMMON_KEYS = ['type', 'title', 'description', 'default'] as const;
const STRING_KEYS = [...COMMON_KEYS, 'enum', 'enumNames', 'minLength', 'maxLength', 'format'] as const;
const NUMBER_KEYS = [...COMMON_KEYS, 'minimum', 'maximum'] as const;

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

const propertyOf = (value: unknown): ElicitationProperty | undefined => {
  if (!isRecord(value) || !['string', 'number', 'integer', 'boolean'].includes(String(value.type))) return undefined;
  if (value.title !== undefined && typeof value.title !== 'string') return undefined;
  if (value.description !== undefined && typeof value.description !== 'string') return undefined;
  if (value.type === 'string') {
    if (!hasOnlyKeys(value, STRING_KEYS)) return undefined;
    if (value.default !== undefined && typeof value.default !== 'string') return undefined;
    if (value.minLength !== undefined && (!Number.isSafeInteger(value.minLength) || Number(value.minLength) < 0)) return undefined;
    if (value.maxLength !== undefined && (!Number.isSafeInteger(value.maxLength) || Number(value.maxLength) < 0)) return undefined;
    if (typeof value.minLength === 'number' && typeof value.maxLength === 'number' && value.minLength > value.maxLength) return undefined;
    if (value.format !== undefined && !['email', 'uri', 'date', 'date-time'].includes(String(value.format))) return undefined;
    if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length === 0 || !value.enum.every((item) => typeof item === 'string'))) return undefined;
    if (value.enumNames !== undefined && (!Array.isArray(value.enum) || !Array.isArray(value.enumNames) || !value.enumNames.every((item) => typeof item === 'string') || value.enum.length !== value.enumNames.length)) return undefined;
    if (Array.isArray(value.enum) && new Set(value.enum).size !== value.enum.length) return undefined;
    if (typeof value.default === 'string' && Array.isArray(value.enum) && !value.enum.includes(value.default)) return undefined;
  } else if (value.type === 'number' || value.type === 'integer') {
    if (!hasOnlyKeys(value, NUMBER_KEYS)) return undefined;
    for (const key of ['default', 'minimum', 'maximum'] as const) {
      const item = value[key];
      if (item !== undefined && (typeof item !== 'number' || !Number.isFinite(item) || (value.type === 'integer' && !Number.isInteger(item)))) return undefined;
    }
    if (typeof value.minimum === 'number' && typeof value.maximum === 'number' && value.minimum > value.maximum) return undefined;
    if (typeof value.default === 'number' && ((typeof value.minimum === 'number' && value.default < value.minimum) || (typeof value.maximum === 'number' && value.default > value.maximum))) return undefined;
  } else if (!hasOnlyKeys(value, COMMON_KEYS) || (value.default !== undefined && typeof value.default !== 'boolean')) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value)) as unknown as ElicitationProperty;
};

export const isElicitationPart = (part: A2aPart): boolean =>
  isRecord(part.data) && Object.hasOwn(part.data, ELICITATION_EXTENSION_KEY);

export const readElicitation = (message: A2aMessage | undefined): ElicitationRequest | undefined => {
  if (!message?.extensions?.includes(ELICITATION_EXTENSION_URI)) return undefined;
  if (!Array.isArray(message.parts)) return undefined;
  for (const part of message.parts) {
    if (!isRecord(part.data)) continue;
    const request = part.data[ELICITATION_EXTENSION_KEY];
    if (!isRecord(request) || typeof request.message !== 'string' || !isRecord(request.requestedSchema)) continue;
    const schema = request.requestedSchema;
    if (
      schema.type !== 'object' ||
      !isRecord(schema.properties) ||
      !Object.keys(schema).every((key) => ['type', 'properties', 'required'].includes(key))
    ) continue;
    const properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, value]) => [name, propertyOf(value)]),
    );
    if (Object.values(properties).some((value) => value === undefined)) continue;
    if (
      schema.required !== undefined &&
      (!Array.isArray(schema.required) ||
        !schema.required.every((name) => typeof name === 'string' && Object.hasOwn(properties, name)) ||
        new Set(schema.required).size !== schema.required.length)
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

const validDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
};

const validDateTime = (value: string): boolean => {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !validDate(match[1])) return false;
  const [, , hour, minute, second, zone] = match;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false;
  if (zone !== 'Z') {
    const [zoneHour, zoneMinute] = zone.slice(1).split(':').map(Number);
    if (zoneHour > 23 || zoneMinute > 59) return false;
  }
  return !Number.isNaN(Date.parse(value));
};

const validEmail = (value: string): boolean => {
  const atom = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
  const label = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
  return new RegExp(`^${atom}(?:\\.${atom})*@${label}(?:\\.${label})*$`).test(value);
};

const assertFormat = (name: string, value: string, format: ElicitationProperty['format']): void => {
  if (format === 'email' && !validEmail(value)) throw new Error(`${name} must be a valid email address`);
  if (format === 'uri') {
    try {
      new URL(value);
    } catch {
      throw new Error(`${name} must be a valid URI`);
    }
  }
  if (format === 'date' && !validDate(value)) throw new Error(`${name} must be a valid date`);
  if (format === 'date-time' && !validDateTime(value)) {
    throw new Error(`${name} must be a valid date-time with a timezone`);
  }
};

export const responseFromForm = (form: FormData, request: ElicitationRequest): ElicitationResponse => {
  const action = String(form.get('elicitationAction') ?? 'accept');
  if (action === 'decline' || action === 'cancel') return { action };
  if (action !== 'accept') throw new Error('invalid elicitation action');
  const required = new Set(request.requestedSchema.required ?? []);
  const entries: [string, string | number | boolean][] = [];
  for (const [name, property] of Object.entries(request.requestedSchema.properties)) {
    const raw = form.get(`field:${name}`);
    if (property.type === 'boolean') {
      if (raw === null) {
        if (required.has(name)) throw new Error(`${property.title ?? name} is required`);
        continue;
      }
      if (raw !== 'true' && raw !== 'false') throw new Error(`${property.title ?? name} must be true or false`);
      entries.push([name, raw === 'true']);
      continue;
    }
    const text = String(raw ?? '');
    if (text.length === 0) {
      if (required.has(name)) throw new Error(`${property.title ?? name} is required`);
      continue;
    }
    if (property.enum && !property.enum.includes(text)) throw new Error(`${property.title ?? name} is not an allowed choice`);
    if (property.minLength !== undefined && text.length < property.minLength) throw new Error(`${property.title ?? name} is too short`);
    if (property.maxLength !== undefined && text.length > property.maxLength) throw new Error(`${property.title ?? name} is too long`);
    if (property.type === 'string') assertFormat(property.title ?? name, text, property.format);
    entries.push([name, property.type === 'string' ? text : numberValue(property.title ?? name, raw, property)]);
  }
  const content = Object.fromEntries(entries) as Record<string, string | number | boolean>;
  const selectedOther = Object.entries(request.requestedSchema.properties).some(
    ([name, property]) => property.enum?.includes('other') && content[name] === 'other',
  );
  if (selectedOther && request.requestedSchema.properties.other?.type === 'string') {
    const other = content.other;
    if (typeof other !== 'string' || other.trim().length === 0) {
      throw new Error('Other is required when the Other choice is selected');
    }
  }
  return { action: 'accept', content };
};

export const elicitationText = (response: ElicitationResponse): string =>
  response.action === 'accept'
    ? `Accepted requested input: ${JSON.stringify(response.content)}`
    : response.action === 'decline'
      ? 'Declined the requested input.'
      : 'Canceled the requested input.';
