import { execSync } from 'child_process';
import readline from 'readline';
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

    // 构建完成后执行部署（Vite 构建钩子）
    async buildEnd() {
      const confirmed = await askForConfirmation('构建已完成，是否立即部署到远程服务器？');
      if (!confirmed) {
        console.log(chalk.yellow('⏹️ 已取消部署。'));
        return;
      }

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




// 回滚函数
export async function rollback(options: AutoDeployOptions) {
  // 1. 初始化配置（同部署逻辑）
  if (!options.remoteIp) throw new Error(chalk.red('❌ 缺少 remoteIp'));
  if (!options.remoteDir) throw new Error(chalk.red('❌ 缺少 remoteDir'));

  const config: AutoDeployOptions & {
    remoteUser: string;
    remotePort: string;
    backupDir: string;
  } = {
    remoteUser: 'root',
    remotePort: '22',
    backupDir: `${options.remoteDir}_backups`,
    ...options,
  };

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