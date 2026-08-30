// 兼容旧的 `npm run runner:start` 入口，但执行逻辑统一走 public/runner。
// 旧版本会把项目目录直接当作数据库工作目录；现在所有流水线输入必须先从
// Sites D1 领取，项目目录只用于本地执行代码和技能。
const args = process.argv.slice(2);
appendEnvOption(args, "site", "DIRECTOR_SITE_URL");
appendEnvOption(args, "token", "DIRECTOR_RUNNER_TOKEN");
appendEnvOption(args, "device", "DIRECTOR_RUNNER_DEVICE_ID");
appendEnvOption(args, "project-dir", "DIRECTOR_PROJECT_DIR");
process.argv = [process.argv[0], process.argv[1], ...args];

await import("../public/runner/director-runner.mjs");

function appendEnvOption(args, option, envName) {
  if (args.includes(`--${option}`)) return;
  const value = process.env[envName]?.trim();
  if (value) args.push(`--${option}`, value);
}
