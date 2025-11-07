import { execSync } from 'child_process';
import chalk from 'chalk';
import type { Plugin } from 'vite';

/**
 * 插件配置选项类型定义
 */
export interface AutoDeployOptions {
  /** 服务器用户名（默认：root） */
  remoteUser?: string;
  /** 服务器 IP 地址（必填） */
  remoteIp: string;
  /** SSH 端口（默认：22） */
  remotePort?: string;
  /** 服务器目标目录（存放 dist 的父目录，必填） */
  remoteDir: string;
  /** 旧版本备份目录（默认：`${remoteDir}_backups`） */
  backupDir?: string;
  /** SSH 私钥路径（可选，优先于密码登录） */
  privateKey?: string;
  /** 传输方式（scp/rsync，默认：scp） */
  transport?: 'scp' | 'rsync';
}

/**
 * Vite 自动部署插件
 * @param options 部署配置
 * @returns Vite 插件对象
 */
export default function viteAutoDeploy(options: AutoDeployOptions): Plugin {
  // 1. 校验必填参数（手动确保核心参数存在）
  if (!options.remoteIp) {
    throw new Error(chalk.red('❌ 缺少必填配置：remoteIp（服务器 IP）'));
  }
  if (!options.remoteDir) {
    throw new Error(chalk.red('❌ 缺少必填配置：remoteDir（服务器目标目录）'));
  }

  // 2. 合并默认配置（保留可选属性的灵活性）
  const config: AutoDeployOptions & {
    // 补充默认值，同时允许可选属性为 undefined
    remoteUser: string;
    remotePort: string;
    transport: 'scp' | 'rsync';
    backupDir: string;
  } = {
    remoteUser: 'root',
    remotePort: '22',
    transport: 'scp',
    backupDir: `${options.remoteDir}_backups`,
    ...options,
  };

  /**
   * 构建 SSH 基础命令（支持私钥登录）
   */
  const getSshBaseCmd = (): string => {
    let cmd = `ssh -p ${config.remotePort}`;
    if (config.privateKey) { // privateKey 可选，存在时才添加
      cmd += ` -i ${config.privateKey}`;
    }
    return `${cmd} ${config.remoteUser}@${config.remoteIp}`;
  };

  return {
    name: 'vite-plugin-auto-deploy',

    // 构建完成后执行部署（Vite 构建钩子）
    buildEnd() {
      console.log(chalk.blue('\n🚀 开始自动部署...'));

      try {
        // 1. 生成备份文件名（时间戳格式：2025-11-07-12-34-56）
        const timestamp = new Date()
          .toISOString()
          .replace(/[:T.]/g, '-')
          .slice(0, 19);
        const backupFile = `${config.backupDir}/${timestamp}_backup.tar.gz`;

        // 2. 备份服务器旧版本（创建备份目录 + 打包）
        console.log(chalk.yellow('💾 备份旧版本中...'));
        const sshBase = getSshBaseCmd();
        execSync(
          `${sshBase} "mkdir -p ${config.backupDir} && tar -zcvf ${backupFile} -C ${config.remoteDir} ."`,
          { stdio: 'inherit' }
        );

        // 3. 上传本地 dist 目录（包含 dist 本身）
        console.log(chalk.yellow('📤 上传新版本中...'));
        let transferCmd = '';

        if (config.transport === 'scp') {
          // SCP 传输命令
          transferCmd = `scp -r -P ${config.remotePort}`;
          if (config.privateKey) transferCmd += ` -i ${config.privateKey}`;
          transferCmd += ` ./dist ${config.remoteUser}@${config.remoteIp}:${config.remoteDir}`;
        } else if (config.transport === 'rsync') {
          // Rsync 传输命令
          transferCmd = `rsync -avz -e "ssh -p ${config.remotePort} ${
            config.privateKey ? `-i ${config.privateKey}` : ''
          }" ./dist ${config.remoteUser}@${config.remoteIp}:${config.remoteDir}`;
        }

        execSync(transferCmd, { stdio: 'inherit' });

        // 4. 部署成功提示
        console.log(chalk.green('✅ 部署成功！'));
        console.log(chalk.green(`旧版本备份路径：${backupFile}`));
      } catch (error) {
        console.error(chalk.red('❌ 部署失败：'), (error as Error).message);
        process.exit(1);
      }
    },
  };
}