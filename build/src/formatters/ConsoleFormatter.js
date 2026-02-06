/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { createStackTraceForConsoleMessage, SymbolizedError, } from '../DevtoolsUtils.js';
import { UncaughtError } from '../PageCollector.js';
export class ConsoleFormatter {
    #id;
    #type;
    #text;
    #argCount;
    #resolvedArgs;
    #stack;
    #cause;
    constructor(params) {
        this.#id = params.id;
        this.#type = params.type;
        this.#text = params.text;
        this.#argCount = params.argCount ?? 0;
        this.#resolvedArgs = params.resolvedArgs ?? [];
        this.#stack = params.stack;
        this.#cause = params.cause;
    }
    static async from(msg, options) {
        if (msg instanceof UncaughtError) {
            const error = await SymbolizedError.fromDetails({
                devTools: options?.devTools,
                details: msg.details,
                targetId: msg.targetId,
                includeStackAndCause: options?.fetchDetailedData,
                resolvedStackTraceForTesting: options?.resolvedStackTraceForTesting,
                resolvedCauseForTesting: options?.resolvedCauseForTesting,
            });
            return new ConsoleFormatter({
                id: options.id,
                type: 'error',
                text: error.message,
                stack: error.stackTrace,
                cause: error.cause,
            });
        }
        let resolvedArgs = [];
        if (options.resolvedArgsForTesting) {
            resolvedArgs = options.resolvedArgsForTesting;
        }
        else if (options.fetchDetailedData) {
            resolvedArgs = await Promise.all(msg.args().map(async (arg, i) => {
                try {
                    const remoteObject = arg.remoteObject();
                    if (remoteObject.type === 'object' &&
                        remoteObject.subtype === 'error') {
                        return await SymbolizedError.fromError({
                            devTools: options.devTools,
                            error: remoteObject,
                            // @ts-expect-error Internal ConsoleMessage API
                            targetId: msg._targetId(),
                        });
                    }
                    return await arg.jsonValue();
                }
                catch {
                    return `<error: Argument ${i} is no longer available>`;
                }
            }));
        }
        let stack;
        if (options.resolvedStackTraceForTesting) {
            stack = options.resolvedStackTraceForTesting;
        }
        else if (options.fetchDetailedData && options.devTools) {
            try {
                stack = await createStackTraceForConsoleMessage(options.devTools, msg);
            }
            catch {
                // ignore
            }
        }
        return new ConsoleFormatter({
            id: options.id,
            type: msg.type(),
            text: msg.text(),
            argCount: resolvedArgs.length || msg.args().length,
            resolvedArgs,
            stack,
        });
    }
    // The short format for a console message.
    toString() {
        return `msgid=${this.#id} [${this.#type}] ${this.#text} (${this.#argCount} args)`;
    }
    // The verbose format for a console message, including all details.
    toStringDetailed() {
        const result = [
            `ID: ${this.#id}`,
            `Message: ${this.#type}> ${this.#text}`,
            this.#formatArgs(),
            this.#formatStackTrace(this.#stack, this.#cause, {
                includeHeading: true,
                includeNote: true,
            }),
        ].filter(line => !!line);
        return result.join('\n');
    }
    #getArgs() {
        if (this.#resolvedArgs.length > 0) {
            const args = [...this.#resolvedArgs];
            // If there is no text, the first argument serves as text (see formatMessage).
            if (!this.#text) {
                args.shift();
            }
            return args;
        }
        return [];
    }
    #formatArg(arg) {
        if (arg instanceof SymbolizedError) {
            return [
                arg.message,
                this.#formatStackTrace(arg.stackTrace, arg.cause, {
                    includeHeading: false,
                    includeNote: true,
                }),
            ]
                .filter(line => !!line)
                .join('\n');
        }
        return typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
    }
    #formatArgs() {
        const args = this.#getArgs();
        if (!args.length) {
            return '';
        }
        const result = ['### Arguments'];
        for (const [key, arg] of args.entries()) {
            result.push(`Arg #${key}: ${this.#formatArg(arg)}`);
        }
        return result.join('\n');
    }
    #formatStackTrace(stackTrace, cause, opts) {
        if (!stackTrace) {
            return '';
        }
        return [
            opts.includeHeading ? '### Stack trace' : '',
            this.#formatFragment(stackTrace.syncFragment),
            ...stackTrace.asyncFragments.map(this.#formatAsyncFragment.bind(this)),
            this.#formatCause(cause),
            opts.includeNote
                ? 'Note: line and column numbers use 1-based indexing'
                : '',
        ]
            .filter(line => !!line)
            .join('\n');
    }
    #formatFragment(fragment) {
        return fragment.frames.map(this.#formatFrame.bind(this)).join('\n');
    }
    #formatAsyncFragment(fragment) {
        const separatorLineLength = 40;
        const prefix = `--- ${fragment.description || 'async'} `;
        const separator = prefix + '-'.repeat(separatorLineLength - prefix.length);
        return separator + '\n' + this.#formatFragment(fragment);
    }
    #formatFrame(frame) {
        let result = `at ${frame.name ?? '<anonymous>'}`;
        if (frame.uiSourceCode) {
            const location = frame.uiSourceCode.uiLocation(frame.line, frame.column);
            result += ` (${location.linkText(/* skipTrim */ false, /* showColumnNumber */ true)})`;
        }
        else if (frame.url) {
            result += ` (${frame.url}:${frame.line}:${frame.column})`;
        }
        return result;
    }
    #formatCause(cause) {
        if (!cause) {
            return '';
        }
        return [
            `Caused by: ${cause.message}`,
            this.#formatStackTrace(cause.stackTrace, cause.cause, {
                includeHeading: false,
                includeNote: false,
            }),
        ]
            .filter(line => !!line)
            .join('\n');
    }
    toJSON() {
        return {
            type: this.#type,
            text: this.#text,
            argsCount: this.#argCount,
            id: this.#id,
        };
    }
    toJSONDetailed() {
        return {
            id: this.#id,
            type: this.#type,
            text: this.#text,
            args: this.#getArgs().map(arg => typeof arg === 'object' ? arg : String(arg)),
            stackTrace: this.#stack,
        };
    }
}
