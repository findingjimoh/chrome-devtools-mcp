/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { zod } from '../third_party/index.js';
/**
 * Unwraps ZodOptional, ZodDefault, ZodNullable, and ZodEffects to find the
 * base type name (e.g. "ZodNumber", "ZodBoolean", "ZodString").
 */
function getBaseTypeName(schema) {
    let current = schema;
    for (;;) {
        const name = current._def?.typeName;
        if (name === 'ZodOptional' ||
            name === 'ZodDefault' ||
            name === 'ZodNullable') {
            current = current._def.innerType;
        }
        else if (name === 'ZodEffects') {
            current = current._def.schema;
        }
        else {
            return name ?? 'unknown';
        }
    }
}
/**
 * Wraps a zod schema field with string-to-primitive coercion when the
 * underlying type is a number or boolean. MCP clients may serialize all
 * parameters as strings, causing strict zod validation to reject them.
 */
function coerceField(field) {
    const base = getBaseTypeName(field);
    if (base === 'ZodNumber') {
        return zod.preprocess(val => {
            if (typeof val === 'string') {
                const n = Number(val);
                if (!Number.isNaN(n)) {
                    return n;
                }
            }
            return val;
        }, field);
    }
    if (base === 'ZodBoolean') {
        return zod.preprocess(val => {
            if (val === 'true') {
                return true;
            }
            if (val === 'false') {
                return false;
            }
            return val;
        }, field);
    }
    return field;
}
/**
 * Applies string coercion to all number and boolean fields in a schema.
 */
function coerceSchema(schema) {
    const result = {};
    for (const [key, field] of Object.entries(schema)) {
        result[key] = coerceField(field);
    }
    return result;
}
export function defineTool(definition) {
    return {
        ...definition,
        schema: coerceSchema(definition.schema),
    };
}
export const CLOSE_PAGE_ERROR = 'The last open page cannot be closed. It is fine to keep it open.';
export const timeoutSchema = {
    timeout: zod
        .number()
        .int()
        .optional()
        .describe(`Maximum wait time in milliseconds. If set to 0, the default timeout will be used.`)
        .transform(value => {
        return value && value <= 0 ? undefined : value;
    }),
};
