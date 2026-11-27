/**
 * `jpeg-js` / `pngjs` 的最小类型声明（两个包都不带 .d.ts）。
 *
 * 只声明我们实际用到的那几个入口 —— 刻意保持最小，避免「照着别人的类型写一遍」
 * 而与真实运行期行为漂移（铁律：不猜测）。
 * 用到的能力见 `packages/core/src/selector/android-graphics.ts`。
 */

declare module 'jpeg-js' {
  export interface JpegDecoded {
    width: number;
    height: number;
    /** RGBA（`formatAsRGBA` 默认 true） */
    data: Uint8Array;
  }
  export interface JpegEncoded {
    data: Uint8Array;
    width: number;
    height: number;
  }
  export function decode(
    data: Uint8Array,
    opts?: { useTArray?: boolean; formatAsRGBA?: boolean; maxMemoryUsageInMB?: number },
  ): JpegDecoded;
  export function encode(
    img: { data: Uint8Array; width: number; height: number },
    quality?: number,
  ): JpegEncoded;
}

declare module 'pngjs' {
  export interface PngData {
    width: number;
    height: number;
    /** RGBA */
    data: Uint8Array;
  }
  export class PNG implements PngData {
    constructor(opts?: { width?: number; height?: number });
    width: number;
    height: number;
    data: Uint8Array;
    static sync: {
      read(buf: Uint8Array, opts?: Record<string, unknown>): PngData;
      write(png: PngData, opts?: Record<string, unknown>): Uint8Array;
    };
  }
}

/**
 * `#681` `js-beautify` 无自带类型 —— 只声明我们用到的三个入口（`html` / `css` / `js`）。
 *
 * 包本身是 CJS（`js/index.js` → `src/index`），`esModuleInterop` 下默认导入拿到的是
 * `module.exports` 整个对象（与 `apps/web` 的 CodeField 用法一致）。
 * 用到的地方：`src/diag/material-format.ts`。
 */
declare module 'js-beautify' {
  export interface BeautifyOptions {
    indent_size?: number;
    indent_char?: string;
    indent_inner_html?: boolean;
    wrap_line_length?: number;
    preserve_newlines?: boolean;
    max_preserve_newlines?: number;
    end_with_newline?: boolean;
    content_unformatted?: string[];
    extra_liners?: string[];
    [k: string]: unknown;
  }
  const beautify: {
    html(source: string, opts?: BeautifyOptions): string;
    css(source: string, opts?: BeautifyOptions): string;
    js(source: string, opts?: BeautifyOptions): string;
  };
  export default beautify;
}
