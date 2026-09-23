import { defineConfig } from 'vitest/config';

// 约束 W1：一致性测试必须钉死时区，与 Swift 基准（Asia/Shanghai, UTC+8）一致。
// 在配置文件加载时（早于任何 Date 运算）设置，worker 进程随主进程继承该环境变量。
process.env.TZ = 'Asia/Shanghai';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 双保险：显式把 TZ 注入每个 worker。
    env: { TZ: 'Asia/Shanghai' },
    globals: false,
  },
});
