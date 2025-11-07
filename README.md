# vite-plugin-auto-deploy-plus

一个针对 Vite 项目的自动部署与回滚插件。支持在打包完成后备份远程旧版本、上传新版本，并提供交互式确认与命令行回滚能力。

## 特性

- 打包完成后自动提示是否部署，避免误操作
- 自动备份旧版本，保留多份时间戳归档
- 支持 `scp` / `rsync` 传输方式与 SSH 私钥登录
- 允许自定义构建输出目录、无交互部署等行为
- 提供 CLI `vite-deploy rollback` 一键回滚最新备份

## 安装

```bash
pnpm add -D vite-plugin-auto-deploy-plus
# 或者使用 npm / yarn
```

## 使用方法

`vite.config.ts`

```ts
import { defineConfig } from 'vite';
import viteAutoDeploy from 'vite-plugin-auto-deploy-plus';

export default defineConfig({
  plugins: [
    viteAutoDeploy({
      remoteIp: '1.2.3.4',
      remoteDir: '/var/www/app',
      transport: 'scp',
      autoConfirm: false,
    }),
  ],
});
```

执行打包命令（例如 `pnpm build`）后，终端会询问是否立即部署：

```
构建已完成，是否立即部署到远程服务器？ (y/N):
```

- 输入 `y` 或 `yes` 即部署并执行备份
- 直接回车或输入其他内容会跳过部署
- 若需要在 CI 等非交互环境自动部署，可将 `autoConfirm` 设为 `true`

## 配置项

| 选项           | 类型                | 默认值                     | 说明 |
| -------------- | ------------------- | -------------------------- | ---- |
| `remoteIp`     | `string`            | —                          | 服务器 IP（必填） |
| `remoteDir`    | `string`            | —                          | 服务器部署目录（必填） |
| `remoteUser`   | `string`            | `root`                     | SSH 用户名 |
| `remotePort`   | `string`            | `22`                       | SSH 端口 |
| `backupDir`    | `string`            | `${remoteDir}_backups`     | 服务器备份目录 |
| `transport`    | `'scp' \| 'rsync'` | `scp`                      | 上传方式 |
| `privateKey`   | `string`            | —                          | SSH 私钥路径 |
| `localDist`    | `string`            | Vite `build.outDir` 或 `dist` | 本地构建目录 |
| `autoConfirm`  | `boolean`           | `false`                    | 是否跳过交互直接部署 |

## 回滚操作

1. 确保项目中已正确配置插件（与部署时使用的配置一致）。
2. 在项目根目录执行：

```bash
npx vite-deploy rollback
```

CLI 将自动读取 `vite.config.[ts|js]` 中的插件配置，列出备份并默认回滚到最新备份。

如果 Vite 配置文件不在项目根目录，可通过 `--config` 指定：


> 也可以在 `package.json` 中添加脚本，方便日常使用：
>
> ```json
> {
>   "scripts": {
>     "rollback": "vite-deploy rollback"
>   }
> }
> ```
>
> 之后执行 `pnpm run rollback` / `npm run rollback` 即可触发回滚。

也可以在代码中手动调用：

```ts
import { rollback } from 'vite-plugin-auto-deploy-plus';

await rollback({
  remoteIp: '1.2.3.4',
  remoteDir: '/var/www/app',
});
```

> 仅当远程服务器中存在通过插件生成的备份文件时，回滚才会生效。

## 常见问题

- **为何没有出现部署询问？** 确认是否在执行 `vite build` 且终端支持交互；在 `vite dev` 模式下插件不会部署。
- **需要自动部署怎么办？** 将 `autoConfirm` 设为 `true`，或在 CI 环境中设置对应环境变量并在配置中读取。
- **备份目录太多怎么办？** 备份文件会保存在服务器的 `backupDir` 下，可自行编写计划任务定期清理旧档。

