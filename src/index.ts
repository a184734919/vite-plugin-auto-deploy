import { execSync } from 'child_process';
import readline from 'readline';
import chalk from 'chalk';
import type { Plugin, ResolvedConfig } from 'vite';

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
  /** 本地构建目录（默认使用 Vite 的 build.outDir） */
  localDist?: string;
  /** 是否跳过交互确认并直接部署（适用于 CI） */
  autoConfirm?: boolean;
}

type NormalizedOptions = AutoDeployOptions & {
  remoteUser: string;
  remotePort: string;
  transport: 'scp' | 'rsync';
  backupDir: string;
  localDist: string;
  autoConfirm: boolean;
};

const normalizeOptions = (options: AutoDeployOptions): NormalizedOptions => {
  if (!options.remoteIp) {
    throw new Error(chalk.red('❌ 缺少必填配置：remoteIp（服务器 IP）'));
  }
  if (!options.remoteDir) {
    throw new Error(chalk.red('❌ 缺少必填配置：remoteDir（服务器目标目录）'));
  }

  return {
    remoteUser: options.remoteUser ?? 'root',
    remotePort: options.remotePort ?? '22',
    transport: options.transport ?? 'scp',
    backupDir: options.backupDir ?? `${options.remoteDir}_backups`,
    localDist: options.localDist ?? 'dist',
    autoConfirm: options.autoConfirm ?? false,
    ...options,
  };
};

/**
 * Vite 自动部署插件
 * @param options 部署配置
 * @returns Vite 插件对象
 */
export default function viteAutoDeploy(options: AutoDeployOptions): Plugin {
  const config = normalizeOptions(options);

  let resolvedConfig: ResolvedConfig | null = null;
  let buildOutputDir = config.localDist;

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

  const askForConfirmation = async (message: string): Promise<boolean> => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.log(chalk.yellow('⚠️ 当前环境不支持交互式确认，已跳过部署。'));
      return false;
    }

    return await new Promise<boolean>((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(`${message} (y/N): `, (answer) => {
        rl.close();
        resolve(/^y(es)?$/i.test(answer.trim()));
      });
    });
  };

  return {
    name: 'vite-plugin-auto-deploy',

    configResolved(resolved) {
      resolvedConfig = resolved;
      buildOutputDir = config.localDist || resolved.build.outDir || 'dist';
    },

    // 构建完成后执行部署（仅在 build 命令且打包成功时触发）
    async closeBundle() {
      if (!resolvedConfig || resolvedConfig.command !== 'build') {
        return;
      }

      if (config.autoConfirm !== true) {
        const userConfirmed = await askForConfirmation('构建已完成，是否立即部署到远程服务器？');
        if (!userConfirmed) {
          console.log(chalk.yellow('⏹️ 已取消部署。'));
          return;
        }
      }

      console.log(chalk.blue('\n🚀 开始部署...'));

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
          transferCmd += ` ./${buildOutputDir} ${config.remoteUser}@${config.remoteIp}:${config.remoteDir}`;
        } else if (config.transport === 'rsync') {
          // Rsync 传输命令
          transferCmd = `rsync -avz -e "ssh -p ${config.remotePort} ${
            config.privateKey ? `-i ${config.privateKey}` : ''
          }" ./${buildOutputDir} ${config.remoteUser}@${config.remoteIp}:${config.remoteDir}`;
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




// 回滚函数
export async function rollback(options: AutoDeployOptions) {
  const config = normalizeOptions(options);

  const sshBase = `ssh -p ${config.remotePort} ${
    config.privateKey ? `-i ${config.privateKey} ` : ''
  }${config.remoteUser}@${config.remoteIp}`;

  try {
    // 2. 获取服务器上的备份列表（按时间倒序）
    console.log(chalk.blue('📂 获取备份列表...'));
    const backupsOutput = execSync(
      `${sshBase} "ls -t ${config.backupDir}/*.tar.gz"`, // -t 按修改时间倒序
      { encoding: 'utf-8' }
    );
    const backups = backupsOutput.trim().split('\n').filter(Boolean);

    if (backups.length === 0) {
      throw new Error('没有找到备份文件，请先部署至少一次');
    }

    // 3. 选择回滚版本（默认选最新的第一个备份）
    console.log(chalk.yellow('🔍 可用的备份版本：'));
    backups.forEach((backup, index) => {
      console.log(`  ${index + 1}. ${backup}`);
    });
    const targetBackup = backups[0]; // 默认回滚到最新备份
    console.log(chalk.green(`✓ 选择回滚到：${targetBackup}`));

    // 4. 执行回滚（解压备份到当前目录，覆盖现有文件）
    console.log(chalk.yellow('⏳ 正在回滚...'));
    execSync(
      `${sshBase} "tar -zxvf ${targetBackup} -C ${config.remoteDir}"`, // -C 指定解压到目标目录
      { stdio: 'inherit' }
    );

    console.log(chalk.green('✅ 回滚成功！已恢复到：', targetBackup));
  } catch (error) {
    console.error(chalk.red('❌ 回滚失败：'), (error as Error).message);
    process.exit(1);
  }
}