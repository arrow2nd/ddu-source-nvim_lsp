import { BaseSource, Context, DduItem, Item, SourceOptions } from "https://deno.land/x/ddu_vim@v2.9.2/types.ts";
import { Denops, fn } from "https://deno.land/x/ddu_vim@v2.9.2/deps.ts";
import { ActionData } from "../@ddu-kinds/nvim_lsp.ts";
import {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  DocumentSymbol,
  Location,
  LocationLink,
  Position,
  ReferenceContext,
  SymbolInformation,
  SymbolKind,
  TextDocumentIdentifier,
  WorkspaceSymbol,
} from "npm:vscode-languageserver-types@3.17.4-next.0";
import { isLike } from "https://deno.land/x/unknownutil@v2.1.1/is.ts";
import { isAbsolute, toFileUrl } from "https://deno.land/std@0.190.0/path/mod.ts";

const VALID_METHODS = {
  "textDocument/declaration": "textDocument/declaration",
  "textDocument/definition": "textDocument/definition",
  "textDocument/typeDefinition": "textDocument/typeDefinition",
  "textDocument/implementation": "textDocument/implementation",
  "textDocument/references": "textDocument/references",
  "textDocument/documentSymbol": "textDocument/documentSymbol",
  "workspace/symbol": "workspace/symbol",
  "callHierarchy/incomingCalls": "callHierarchy/incomingCalls",
  "callHierarchy/outgoingCalls": "callHierarchy/outgoingCalls",
} as const satisfies Record<string, string>;

type Method = typeof VALID_METHODS[keyof typeof VALID_METHODS];

function isMethod(
  method: string,
): method is Method {
  return Object.values(VALID_METHODS).some((m) => method === m);
}

async function isMethodSupported(
  denops: Denops,
  method: Method,
  bufNr: number,
): Promise<boolean | null> {
  return await denops.call(
    `luaeval`,
    `require('ddu_nvim_lsp').supports_method(_A[1], _A[2])`,
    [bufNr, method],
  ) as boolean | null;
}

interface TextDocumentPositionParams {
  /** The text document. */
  textDocument: TextDocumentIdentifier;
  /** The position inside the text document. */
  position: Position;
}

interface ReferenceParams extends TextDocumentPositionParams {
  context: ReferenceContext;
}

async function makePositionParams(
  denops: Denops,
  bufNr: number,
  winId: number,
): Promise<TextDocumentPositionParams> {
  const [_, lnum, col] = await fn.getcurpos(denops, winId);
  const position: Position = {
    // 1-index to 0-index
    line: lnum - 1,
    character: col - 1,
  };

  return {
    textDocument: await makeTextDocumentIdentifier(denops, bufNr),
    position,
  };
}

async function makeTextDocumentIdentifier(
  denops: Denops,
  bufNr: number,
): Promise<TextDocumentIdentifier> {
  const filepath = await denops.eval(`fnamemodify(bufname(${bufNr}), ":p")`) as string;
  const uri = isAbsolute(filepath) ? toFileUrl(filepath).href : filepath;
  return { uri };
}

/** Array of results per client */
type Response = unknown[];

async function lspRequest(
  denops: Denops,
  bufnr: number,
  method: Method | "workspaceSymbol/resolve" | "textDocument/prepareCallHierarchy",
  params: unknown,
): Promise<Response | null> {
  return await denops.call(
    `luaeval`,
    `require('ddu_nvim_lsp').request(${bufnr}, '${method}', _A)`,
    params,
  ) as Response | null;
}

type Params = {
  method: string;
  query: string;
};

export class Source extends BaseSource<Params> {
  kind = "nvim_lsp";

  gather(args: {
    denops: Denops;
    sourceParams: Params;
    sourceOptions: SourceOptions;
    context: Context;
    input: string;
    parent?: DduItem;
  }): ReadableStream<Item<ActionData>[]> {
    const { denops, sourceParams, sourceOptions, context: ctx } = args;
    const method = sourceParams.method;

    return new ReadableStream({
      async start(controller) {
        if (!isMethod(method)) {
          console.log(`Unknown method: ${method}`);
          controller.close();
          return;
        }

        const isSupported = await isMethodSupported(denops, method, ctx.bufNr);
        if (!isSupported) {
          if (isSupported === false) {
            console.log(`${method} is not supported by any of the servers`);
          } else {
            console.log("No server attached");
          }
          controller.close();
          return;
        }

        switch (method) {
          case VALID_METHODS["textDocument/declaration"]:
          case VALID_METHODS["textDocument/definition"]:
          case VALID_METHODS["textDocument/typeDefinition"]:
          case VALID_METHODS["textDocument/implementation"]: {
            const params = await makePositionParams(denops, ctx.bufNr, ctx.winId);
            const response = await lspRequest(denops, ctx.bufNr, method, params);
            if (response) {
              const items = definitionHandler(response);
              controller.enqueue(items);
            }
            break;
          }
          case VALID_METHODS["textDocument/references"]: {
            const params = await makePositionParams(denops, ctx.bufNr, ctx.winId) as ReferenceParams;
            params.context = {
              includeDeclaration: true,
            };
            const response = await lspRequest(denops, ctx.bufNr, method, params);
            if (response) {
              const items = referencesHandler(response);
              controller.enqueue(items);
            }
            break;
          }
          case VALID_METHODS["textDocument/documentSymbol"]: {
            const params = {
              textDocument: await makeTextDocumentIdentifier(denops, ctx.bufNr),
            };
            const response = await lspRequest(denops, ctx.bufNr, method, params);
            if (response) {
              const items = documentSymbolHandler(response, ctx.bufNr);
              controller.enqueue(items);
            }
            break;
          }
          case VALID_METHODS["workspace/symbol"]: {
            const params = {
              query: sourceOptions.volatile ? args.input : sourceParams.query,
            };
            const response = await lspRequest(denops, ctx.bufNr, method, params);
            if (response) {
              const items = workspaceSymbolHandler(response, denops, ctx.bufNr);
              controller.enqueue(items);
            }
            break;
          }
          case VALID_METHODS["callHierarchy/incomingCalls"]:
          case VALID_METHODS["callHierarchy/outgoingCalls"]: {
            const searchChildren = async (callHierarchyItem: CallHierarchyItem) => {
              const response = await lspRequest(denops, ctx.bufNr, method, { item: callHierarchyItem });
              if (response) {
                return callHierarchyHandler(response);
              }
            };

            const peek = async (parent: Item<ActionData>) => {
              const hierarchyParent = parent.data as CallHierarchyItem;
              const children = await searchChildren(hierarchyParent);
              if (children && children.length > 0) {
                children.forEach((child) => {
                  child.treePath = `${parent.treePath}/${(child.data as CallHierarchyItem).name}`;
                });
                parent.isTree = true;
                parent.data = {
                  ...hierarchyParent,
                  children,
                };
              } else {
                parent.isTree = false;
              }
              return parent;
            };

            if (args.parent) {
              // called from expandItem
              if (isLike({ data: { children: [] } }, args.parent)) {
                const resolvedChildren = await Promise.all(args.parent.data.children.map(peek));
                controller.enqueue(resolvedChildren);
              }
            } else {
              const params = await makePositionParams(denops, ctx.bufNr, ctx.winId);
              const callHierarchyItems = await prepareCallHierarchy(denops, ctx.bufNr, params);
              if (callHierarchyItems && callHierarchyItems.length > 0) {
                const items = callHierarchyItems.map(callHierarchyItemToItem);
                const resolvedItems = await Promise.all(items.map(peek));
                controller.enqueue(resolvedItems);
              }
            }
            break;
          }
          default: {
            method satisfies never;
          }
        }

        controller.close();
      },
    });
  }

  params(): Params {
    return {
      method: "",
      query: "",
    };
  }
}

function definitionHandler(
  response: Response,
): Item<ActionData>[] {
  return response.flatMap((result) => {
    /**
     * References:
     * https://microsoft.github.io/language-server-protocol/specifications/specification-current/#textDocument_declaration
     * https://microsoft.github.io/language-server-protocol/specifications/specification-current/#textDocument_definition
     * https://microsoft.github.io/language-server-protocol/specifications/specification-current/#textDocument_typeDefinition
     * https://microsoft.github.io/language-server-protocol/specifications/specification-current/#textDocument_implementation
     */
    const locations = result as Location | Location[] | LocationLink[];

    if (!Array.isArray(locations)) {
      return [locations];
    } else {
      return locations.map(toLocation);
    }
  }).filter((location) => !isDenoUriWithFragment(location))
    .map(locationToItem);
}

function referencesHandler(
  response: Response,
): Item<ActionData>[] {
  return response.flatMap((result) => {
    /**
     * Reference:
     * https://microsoft.github.io/language-server-protocol/specifications/specification-current/#textDocument_references
     */
    const locations = result as Location[];
    return locations;
  }).filter((location) => !isDenoUriWithFragment(location))
    .map(locationToItem);
}

function toLocation(loc: Location | LocationLink): Location {
  if ("uri" in loc && "range" in loc) {
    return loc;
  } else {
    return {
      uri: loc.targetUri,
      range: loc.targetSelectionRange,
    };
  }
}

function isDenoUriWithFragment(location: Location) {
  const { uri } = location;
  /**
   * Workaround. https://github.com/denoland/deno/issues/19304
   * filter deno virtual buffers with udd fragments
   * #(^|~|<|=)
   */
  return /^deno:.*%23(%5E|%7E|%3C|%3D)/.test(uri);
}

function locationToItem(
  location: Location,
): Item<ActionData> {
  const { uri, range } = location;
  const path = uriToPath(uri);
  const { line, character } = range.start;
  const [lineNr, col] = [line + 1, character + 1];
  return {
    word: path,
    display: `${path}:${lineNr}:${col}`,
    action: {
      path,
      range: location.range,
    },
    data: location,
  };
}

function uriToPath(uri: string) {
  if (uri.startsWith("file:")) {
    return new URL(uri).pathname;
  } else {
    return uri;
  }
}

function documentSymbolHandler(
  response: Response,
  bufNr: number,
): Item<ActionData>[] {
  const items = response.flatMap((result) => {
    /**
     * Reference:
     * https://microsoft.github.io/language-server-protocol/specifications/specification-current/#textDocument_documentSymbol
     */
    const symbols = result as DocumentSymbol[] | SymbolInformation[];

    return symbols.map((symbol) => {
      const kindName = KindName[symbol.kind];
      const kind = `[${kindName}]`.padEnd(15, " ");
      if ("location" in symbol) {
        // symbol is SymbolInformation
        return {
          word: `${kind} ${symbol.name}`,
          action: {
            path: uriToPath(symbol.location.uri),
            range: symbol.location.range,
          },
          data: symbol,
        };
      } else {
        // symbol is DocumentSymbol
        return {
          word: `${kind} ${symbol.name}`,
          action: {
            bufNr,
            range: symbol.selectionRange,
          },
          data: symbol,
        };
      }
    });
  });

  items.sort((a, b) => {
    return (a.action?.range?.start.line as number) - (b.action?.range?.start.line as number);
  });

  return items;
}

export const KindName = {
  1: "File",
  2: "Module",
  3: "Namespace",
  4: "Package",
  5: "Class",
  6: "Method",
  7: "Property",
  8: "Field",
  9: "Constructor",
  10: "Enum",
  11: "Interface",
  12: "Function",
  13: "Variable",
  14: "Constant",
  15: "String",
  16: "Number",
  17: "Boolean",
  18: "Array",
  19: "Object",
  20: "Key",
  21: "Null",
  22: "EnumMember",
  23: "Struct",
  24: "Event",
  25: "Operator",
  26: "TypeParameter",
} as const satisfies Record<SymbolKind, string>;

export type KindName = typeof KindName[keyof typeof KindName];

function workspaceSymbolHandler(
  response: Response,
  denops: Denops,
  bufNr: number,
): Item<ActionData>[] {
  return response.flatMap((result) => {
    /**
     * Reference:
     * https://microsoft.github.io/language-server-protocol/specifications/specification-current/#workspace_symbol
     */
    const symbols = result as SymbolInformation[] | WorkspaceSymbol[];

    return symbols.map((symbol) => {
      let action;
      if ("range" in symbol.location) {
        action = {
          path: uriToPath(symbol.location.uri),
          range: symbol.location.range,
        };
      } else {
        action = {
          path: uriToPath(symbol.location.uri),
          resolve: async () => {
            const resolveResponse = await lspRequest(denops, bufNr, "workspaceSymbol/resolve", symbol);
            if (resolveResponse) {
              /**
               * https://microsoft.github.io/language-server-protocol/specifications/specification-current/#workspace_symbolResolve
               */
              const workspaceSymbol = resolveResponse[0] as WorkspaceSymbol;
              return (workspaceSymbol.location as Location).range;
            }
          },
        };
      }

      const kindName = KindName[symbol.kind];
      const kind = `[${kindName}]`.padEnd(15, " ");
      return {
        word: `${kind} ${symbol.name}`,
        action,
        data: symbol,
      };
    });
  });
}

async function prepareCallHierarchy(
  denops: Denops,
  bufNr: number,
  params: TextDocumentPositionParams,
): Promise<CallHierarchyItem[] | undefined> {
  const response = await lspRequest(denops, bufNr, "textDocument/prepareCallHierarchy", params);
  if (response) {
    return response.flatMap((result) => {
      /**
       * Reference:
       * https://microsoft.github.io/language-server-protocol/specifications/specification-current/#textDocument_prepareCallHierarchy
       */
      const callHierarchyItems = result as CallHierarchyItem[];
      return callHierarchyItems;
    });
  }
}

function callHierarchyHandler(
  response: Response,
): Item<ActionData>[] {
  return response.flatMap((result) => {
    /**
     * References:
     * https://microsoft.github.io/language-server-protocol/specifications/specification-current/#callHierarchy_incomingCalls
     * https://microsoft.github.io/language-server-protocol/specifications/specification-current/#callHierarchy_outgoingCalls
     */
    const calls = result as CallHierarchyIncomingCall[] | CallHierarchyOutgoingCall[];

    return calls.flatMap((call) => {
      const linkItem = "from" in call ? call.from : call.to;
      const path = uriToPath(linkItem.uri);
      return call.fromRanges.map((range) => {
        return {
          word: linkItem.name,
          display: `${linkItem.name}:${range.start.line + 1}:${range.start.character + 1}`,
          action: {
            path,
            range,
          },
          data: linkItem,
        };
      });
    });
  });
}

function callHierarchyItemToItem(
  item: CallHierarchyItem,
): Item<ActionData> {
  return {
    word: item.name,
    action: {
      path: uriToPath(item.uri),
      range: item.selectionRange,
    },
    treePath: `/${item.name}`,
    data: item,
  };
}
