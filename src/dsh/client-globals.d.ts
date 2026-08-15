/**
 * 动态插件运行时的全局内建（host/ctx/styles）。
 * client.tsx 是从动态插件原型移植的参考实现，因此声明这些全局以通过
 * 独立类型检查；落库为真实包时按 docs/dsh.md「Client 接线」替换为
 * ClientContext + connection.api，并删除本文件。
 */
declare const host: {
  call(method: string, args?: unknown): Promise<any>
}
declare const ctx: {
  get(name: string): any
}
declare const styles: {
  insert(css: string): () => void
}
