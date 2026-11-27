/**
 * `#612` **ClassShutter 敏感类可达面**（上游 `RhinoClassShutter` 的移植）。
 *
 * ★ 上游依据：`F:\legado/modules/rhino/src/main/java/com/script/rhino/RhinoClassShutter.kt:47-191`
 *   · `protectedClassNamesMatcher`（`:49-119`）：一张「敏感类名 + 包前缀」黑名单；
 *   · 匹配语义（`ClassNameMatcher.matchInternal`）：**全名相等** 或 **`类名.startsWith(前缀) && 类名[前缀长度] === '.'`**
 *     （即前缀必须落在包边界上；`java.io.File` 只挡 `File`，不挡 `java.io.ByteArrayOutputStream`）；
 *   · `systemClassProtectedName`（`:122`）：`java.lang.System` 上只额外挡 **`load`/`loadLibrary`/`exit`**；
 *   · 判定结果 = `visibleToScripts()` 返回 false ⇒ Rhino 里该类**不可见**（`Packages.x.Y` 是 `undefined`，
 *     再往下取成员 ⇒ TypeError）。★ 注意：**不是抛一个友好异常**，而是「取不到」——
 *     本仓因此也把被挡路径返回 `undefined`，与上游逐字对齐。
 *
 * 本仓为什么需要它：我们的 `Packages.*` 有**兜底 Proxy**（未知路径返回「调用 → 空串」的桩，
 * 见 `java-bridge.ts` 的 `nest()`），于是 `Packages.com.script.ScriptEngine` 这类上游**被挡**的路径
 * 在本仓变成了「可调用、返回空串」—— 与上游「不可见」不一致。本模块把黑名单补回去。
 *
 * ⚠️ 宿主（`java-bridge.ts`）与 worker（`sandbox/worker-pool.ts`）**两侧都要判** ——
 *     worker 有自己的一份 Packages 树，只改宿主会导致「同一条规则在 L1 被挡、在 worker 可用」。
 */

/** 上游 `protectedClassNamesMatcher` 的**全名**部分（`:51-119`，原样移植，含 Android/okio 项） */
export const JAVA_SHUTTER_EXACT: readonly string[] = [
  'java.lang.Class',
  'java.lang.ClassLoader',
  'java.net.URLClassLoader',
  'java.lang.Runtime',
  'java.lang.ProcessBuilder',
  'java.lang.ProcessImpl',
  'java.lang.UNIXProcess',
  'java.io.File',
  'java.io.FileDescriptor',
  'java.io.FileInputStream',
  'java.io.FileOutputStream',
  'java.io.PrintStream',
  'java.io.FileReader',
  'java.io.FileWriter',
  'java.io.PrintWriter',
  'java.io.UnixFileSystem',
  'java.io.RandomAccessFile',
  'java.io.ObjectInputStream',
  'java.io.ObjectOutputStream',
  'java.security.AccessController',
  'java.nio.file.Paths',
  'java.nio.file.Files',
  'java.nio.file.FileSystems',
  'java.util.Formatter',
  'sun.misc.Unsafe',
  'android.content.Intent',
  'android.provider.Settings',
  'android.app.ActivityThread',
  'android.app.AppGlobals',
  'android.os.Looper',
  'android.os.Process',
  'android.os.FileUtils',
  'cn.hutool.core.lang.JarClassLoader',
  'cn.hutool.core.lang.Singleton',
  'cn.hutool.core.util.RuntimeUtil',
  'cn.hutool.core.util.ClassLoaderUtil',
  'cn.hutool.core.util.ReflectUtil',
  'cn.hutool.core.util.SerializeUtil',
  'cn.hutool.core.util.ClassUtil',
  'org.htmlunit.corejs.javascript.DefiningClassLoader',
  'io.legado.app.data.AppDatabase',
  'io.legado.app.data.AppDatabase_Impl',
  'io.legado.app.data.AppDatabaseKt',
  'io.legado.app.utils.ContextExtensionsKt',
  'androidx.core.content.FileProvider',
  'splitties.init.AppCtxKt',
  'okio.JvmSystemFileSystem',
  'okio.JvmFileHandle',
  'okio.NioSystemFileSystem',
  'okio.NioFileSystemFileHandle',
  'okio.Path',
];

/** 上游的**包前缀**部分（`:113-118`）：`类名.startsWith(前缀) && 类名[前缀长度] === '.'` */
export const JAVA_SHUTTER_PREFIX: readonly string[] = [
  'android.system',
  'android.database',
  'androidx.sqlite.db',
  'androidx.room',
  'cn.hutool.core.io',
  'cn.hutool.core.bean',
  'cn.hutool.core.lang.reflect',
  'dalvik.system',
  'java.nio.file',
  'java.lang.reflect',
  'java.lang.invoke',
  'io.legado.app.data.dao',
  'com.script',
  'org.mozilla',
  'sun',
  'libcore',
];

/** `java.lang.System` 上额外受保护的方法名（上游 `:122` `systemClassProtectedName`） */
export const JAVA_SYSTEM_PROTECTED: readonly string[] = ['load', 'loadLibrary', 'exit'];

/**
 * 该 Java 路径是否被上游 ClassShutter 拒绝（⇒ 本仓也要返回 `undefined`）。
 * 语义与 `ClassNameMatcher.matchInternal` 一致：**全名相等** 或 **包边界前缀**。
 */
export function isShutteredJavaPath(path: string): boolean {
  if (!path) return false;
  for (const p of JAVA_SHUTTER_EXACT) if (path === p) return true;
  for (const p of JAVA_SHUTTER_PREFIX) {
    // 上游 `ClassNameMatcher` 把前缀项**也当全名参与精确匹配**（`com.script` 本身即被挡），
    // 所以我们逐级下钻时（`Packages.com` → `.script` → `.ScriptEngine`）在包节点上就要拦住。
    if (path === p) return true;
    if (path.startsWith(p) && path.charAt(p.length) === '.') return true;
  }
  return false;
}

/** 供 worker 侧内联成字面量（worker 源码是字符串，不能 import 本模块） */
export function shutterLiterals(): { exact: string[]; prefix: string[] } {
  return { exact: [...JAVA_SHUTTER_EXACT], prefix: [...JAVA_SHUTTER_PREFIX] };
}
