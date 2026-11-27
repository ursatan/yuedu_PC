/** js-beautify 无自带类型 —— 最小声明（仅用 js 格式化） */declare module 'js-beautify' {
  interface BeautifyOptions {
    indent_size?: number;
    indent_char?: string;
    wrap_line_length?: number;
    preserve_newlines?: boolean;
    end_with_newline?: boolean;
    [k: string]: unknown;
  }
  export function js(source: string, opts?: BeautifyOptions): string;
}

/** vite 的 `?url` 静态资产导入（`#326`：hls.js 以静态资产注入 RSS 正文 iframe） */
declare module '*?url' {
  const src: string;
  export default src;
}

/** 构建时注入的产品版本号（`vite.config.ts` 读 `apps/desktop/package.json` 的 version） */
declare const __APP_VERSION__: string;
