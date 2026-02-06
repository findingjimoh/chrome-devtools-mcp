/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {TextSnapshotNode, GeolocationOptions} from '../McpContext.js';
import {zod} from '../third_party/index.js';
import type {
  Dialog,
  ElementHandle,
  Page,
  Viewport,
} from '../third_party/index.js';
import type {InsightName, TraceResult} from '../trace-processing/parse.js';
import type {InstalledExtension} from '../utils/ExtensionRegistry.js';
import type {PaginationOptions} from '../utils/types.js';

import type {ToolCategory} from './categories.js';

export interface ToolDefinition<
  Schema extends zod.ZodRawShape = zod.ZodRawShape,
> {
  name: string;
  description: string;
  annotations: {
    title?: string;
    category: ToolCategory;
    /**
     * If true, the tool does not modify its environment.
     */
    readOnlyHint: boolean;
    conditions?: string[];
  };
  schema: Schema;
  handler: (
    request: Request<Schema>,
    response: Response,
    context: Context,
  ) => Promise<void>;
}

export interface Request<Schema extends zod.ZodRawShape> {
  params: zod.objectOutputType<Schema, zod.ZodTypeAny>;
}

export interface ImageContentData {
  data: string;
  mimeType: string;
}

export interface SnapshotParams {
  verbose?: boolean;
  filePath?: string;
}

export interface DevToolsData {
  cdpRequestId?: string;
  cdpBackendNodeId?: number;
}

export interface Response {
  appendResponseLine(value: string): void;
  setIncludePages(value: boolean): void;
  setIncludeNetworkRequests(
    value: boolean,
    options?: PaginationOptions & {
      resourceTypes?: string[];
      includePreservedRequests?: boolean;
      networkRequestIdInDevToolsUI?: number;
    },
  ): void;
  setIncludeConsoleData(
    value: boolean,
    options?: PaginationOptions & {
      types?: string[];
      includePreservedMessages?: boolean;
    },
  ): void;
  includeSnapshot(params?: SnapshotParams): void;
  attachImage(value: ImageContentData): void;
  attachNetworkRequest(
    reqid: number,
    options?: {requestFilePath?: string; responseFilePath?: string},
  ): void;
  attachConsoleMessage(msgid: number): void;
  // Allows re-using DevTools data queried by some tools.
  attachDevToolsData(data: DevToolsData): void;
  setTabId(tabId: string): void;
  attachTraceSummary(trace: TraceResult): void;
  attachTraceInsight(
    trace: TraceResult,
    insightSetId: string,
    insightName: InsightName,
  ): void;
  setListExtensions(): void;
}

/**
 * Only add methods required by tools/*.
 */
export type Context = Readonly<{
  isRunningPerformanceTrace(): boolean;
  setIsRunningPerformanceTrace(x: boolean): void;
  isCruxEnabled(): boolean;
  recordedTraces(): TraceResult[];
  storeTraceRecording(result: TraceResult): void;
  getSelectedPage(): Page;
  getDialog(): Dialog | undefined;
  clearDialog(): void;
  getPageById(pageId: number): Page;
  getPageId(page: Page): number | undefined;
  isPageSelected(page: Page): boolean;
  newPage(background?: boolean): Promise<Page>;
  closePage(pageId: number): Promise<void>;
  selectPage(page: Page): void;
  getElementByUid(uid: string): Promise<ElementHandle<Element>>;
  getAXNodeByUid(uid: string): TextSnapshotNode | undefined;
  setNetworkConditions(conditions: string | null): void;
  setCpuThrottlingRate(rate: number): void;
  setGeolocation(geolocation: GeolocationOptions | null): void;
  setViewport(viewport: Viewport | null): void;
  getViewport(): Viewport | null;
  setUserAgent(userAgent: string | null): void;
  getUserAgent(): string | null;
  setColorScheme(scheme: 'dark' | 'light' | null): void;
  saveTemporaryFile(
    data: Uint8Array<ArrayBufferLike>,
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp',
  ): Promise<{filename: string}>;
  saveFile(
    data: Uint8Array<ArrayBufferLike>,
    filename: string,
  ): Promise<{filename: string}>;
  waitForEventsAfterAction(
    action: () => Promise<unknown>,
    options?: {timeout?: number},
  ): Promise<void>;
  waitForTextOnPage(text: string, timeout?: number): Promise<Element>;
  getDevToolsData(): Promise<DevToolsData>;
  /**
   * Returns a reqid for a cdpRequestId.
   */
  resolveCdpRequestId(cdpRequestId: string): number | undefined;
  /**
   * Returns a reqid for a cdpRequestId.
   */
  resolveCdpElementId(cdpBackendNodeId: number): string | undefined;
  getForegroundPage(): Promise<{
    page: Page;
    pageId: number | undefined;
    selectedText: string;
  } | null>;
  installExtension(path: string): Promise<string>;
  uninstallExtension(id: string): Promise<void>;
  listExtensions(): InstalledExtension[];
  getExtension(id: string): InstalledExtension | undefined;
}>;

/**
 * Unwraps ZodOptional, ZodDefault, ZodNullable, and ZodEffects to find the
 * base type name (e.g. "ZodNumber", "ZodBoolean", "ZodString").
 */
function getBaseTypeName(schema: zod.ZodTypeAny): string {
  let current = schema;
  for (;;) {
    const name: string = current._def?.typeName;
    if (
      name === 'ZodOptional' ||
      name === 'ZodDefault' ||
      name === 'ZodNullable'
    ) {
      current = current._def.innerType;
    } else if (name === 'ZodEffects') {
      current = current._def.schema;
    } else {
      return name ?? 'unknown';
    }
  }
}

/**
 * Wraps a zod schema field with string-to-primitive coercion when the
 * underlying type is a number or boolean. MCP clients may serialize all
 * parameters as strings, causing strict zod validation to reject them.
 */
function coerceField(field: zod.ZodTypeAny): zod.ZodTypeAny {
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
    }, field) as unknown as zod.ZodTypeAny;
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
    }, field) as unknown as zod.ZodTypeAny;
  }
  return field;
}

/**
 * Applies string coercion to all number and boolean fields in a schema.
 */
function coerceSchema<T extends zod.ZodRawShape>(schema: T): T {
  const result: Record<string, zod.ZodTypeAny> = {};
  for (const [key, field] of Object.entries(schema)) {
    result[key] = coerceField(field);
  }
  return result as T;
}

export function defineTool<Schema extends zod.ZodRawShape>(
  definition: ToolDefinition<Schema>,
) {
  return {
    ...definition,
    schema: coerceSchema(definition.schema),
  };
}

export const CLOSE_PAGE_ERROR =
  'The last open page cannot be closed. It is fine to keep it open.';

export const timeoutSchema = {
  timeout: zod
    .number()
    .int()
    .optional()
    .describe(
      `Maximum wait time in milliseconds. If set to 0, the default timeout will be used.`,
    )
    .transform(value => {
      return value && value <= 0 ? undefined : value;
    }),
};
