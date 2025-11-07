#!/usr/bin/env node

import { register } from 'ts-node';
register({ compilerOptions: { module: 'CommonJS' }, transpileOnly: true }); // 注册 TS 解析

import { program } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import { rollback } from './index.js';
import chalk from 'chalk';

// 读取 package.json 版本
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(path.join(__dirname, '../package.json'), 'utf-8')
);

// 解析命令行参数
program
  .version(pkg.version)
  .description('Vite 自动部署与回滚工具');

// 回滚命令：vite-deploy rollback
program
  .command('rollback')
  .description('回滚到上一个备份版本')
  .option('-c, --config <path>', '指定 vite.config.js 路径（默认：项目根目录）')
  .action(async (options) => {
    // 1. 加载 Vite 配置文件（获取部署参数）
    const resolveViteConfig = (configOption?: string): string => {
      if (configOption) {
        const absolute = path.resolve(configOption);
        if (!existsSync(absolute)) {
          throw new Error(`无法找到指定的配置文件：${absolute}`);
        }
        return absolute;
      }

      const candidates = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs'];
      for (const filename of candidates) {
        const absolute = path.resolve(filename);
        if (existsSync(absolute)) {
          return absolute;
        }
      }

      throw new Error('当前目录中未找到 Vite 配置文件，请使用 --config 指定路径');
    };

    let configPath = '';
    let viteConfig;
    configPath = resolveViteConfig(options.config);

    const tryLoadConfig = async (filepath: string) => {
      const ext = path.extname(filepath).toLowerCase();

      if (ext === '.cjs') {
        const { createRequire } = await import('module');
        const require = createRequire(configPath);
        return require(configPath);
      }

      if (ext === '.js') {
        try {
          return await import(pathToFileURL(configPath).href);
        } catch (err) {
          // 可能是 CommonJS
          if ((err as Error).message?.includes('exports is not defined') || (err as Error).message?.includes('require is not defined')) {
            const { createRequire } = await import('module');
            const require = createRequire(configPath);
            return require(configPath);
          }
          throw err;
        }
      }

      // 默认为 ESM（.ts/.mjs/.cts 需要由 ts-node/register 处理）
      return await import(pathToFileURL(configPath).href);
    };

    try {
      const loadWithVite = async () => {
        try {
          const viteModule = await import('vite');
          if (typeof viteModule.loadConfigFromFile === 'function') {
            const mode = process.env.NODE_ENV || 'production';
            const result = await viteModule.loadConfigFromFile({ command: 'build', mode }, configPath, process.cwd());
            if (result?.config) {
              return result.config;
            }
          }
        } catch (viteError) {
          // 如果 Vite 版本不支持该 API，忽略并回退
        }
        return undefined;
      };

      viteConfig = (await loadWithVite()) ?? (await tryLoadConfig(configPath));
    } catch (error) {
      console.error(chalk.red('❌ 无法加载配置文件：', configPath));
      console.error(chalk.red((error as Error).message));
      process.exit(1);
    }

    // 2. 从 Vite 插件配置中提取部署参数
    const resolvedConfig = viteConfig?.default ?? viteConfig;

    const plugins = Array.isArray(resolvedConfig?.plugins)
      ? resolvedConfig.plugins
      : [];

    const deployPlugin = plugins.find((p: any) => p?.name === 'vite-plugin-auto-deploy-plus');

    const deployOptions = deployPlugin?.__autoDeployOptions ?? deployPlugin?.options;

    if (!deployOptions) {
      console.error(chalk.red('❌ 未找到部署配置，请检查 vite.config.js'));
      process.exit(1);
    }

    // 3. 执行回滚
    await rollback(deployOptions);
  });

program.parse(process.argv);