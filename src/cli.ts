
import { register } from 'ts-node';
register({ compilerOptions: { module: 'CommonJS' } }); // 注册 TS 解析

import { program } from 'commander';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
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
    const configPath = options.config || path.resolve('vite.config.js');
    let viteConfig;
    try {
      viteConfig = await import(configPath);
    } catch (error) {
      console.error(chalk.red('❌ 无法加载配置文件：', configPath));
      process.exit(1);
    }

    // 2. 从 Vite 插件配置中提取部署参数
    const deployOptions = viteConfig.default.plugins
      .find((p: any) => p.name === 'vite-plugin-auto-deploy')
      ?.options;

    if (!deployOptions) {
      console.error(chalk.red('❌ 未找到部署配置，请检查 vite.config.js'));
      process.exit(1);
    }

    // 3. 执行回滚
    await rollback(deployOptions);
  });

program.parse(process.argv);