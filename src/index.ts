import { Context, Schema } from 'koishi';
import { Coordinator, CoordinatorConfig, GroupLink } from './coordinator';

export * from './coordinator';

export const name = 'coordinator';

declare module 'koishi' {
  interface Context {
    coordinator: Coordinator;
  }
  interface Tables {
    groupLinks: GroupLink;
  }
}

export type Config = CoordinatorConfig;

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().description('是否启用多适配器群组协调').default(true),
  suppressCommands: Schema.boolean()
    .default(true)
    .description('是否在被抑制（官方侧）的会话上拦截所有命令执行'),
  onebotSelfId: Schema.string().description('优先使用的 OneBot 机器人 selfId（留空自动选择）'),
  qqSelfId: Schema.string().description('优先使用的 QQ 官方机器人 selfId（留空自动选择）'),
  officialRobotUin: Schema.string().description(
    'QQ 官方机器人的 QQ 号；留空时从官方接口返回的分享链接中自动解析'
  ),
  links: Schema.array(
    Schema.object({
      onebotGroupId: Schema.string().required().description('OneBot 群号'),
      qqGroupOpenid: Schema.string().required().description('QQ 官方群 group_openid'),
      qqSelfId: Schema.string().description('QQ 官方机器人 selfId')
    })
  )
    .default([])
    .description('手动群组映射（仅在无法自动匹配时使用）')
});

export function apply(ctx: Context, config: Config) {
  ctx.plugin(Coordinator, config);
}
