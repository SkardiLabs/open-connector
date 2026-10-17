import type { CredentialValidators, ProviderExecutors, ProviderProxyExecutor } from "../../core/types.ts";

import { createFeishuProviderModule, feishuProxyDefinition } from "../feishu/executors.ts";
import { larkCloud } from "../feishu/shared/cloud.ts";
import { defineProviderProxy } from "../provider-runtime.ts";
import { larkActions } from "./actions.ts";

const larkModule = createFeishuProviderModule({ service: "lark", actions: larkActions, cloud: larkCloud });

export const executors: ProviderExecutors = larkModule.executors;
export const credentialValidators: CredentialValidators = larkModule.credentialValidators;
export const proxy: ProviderProxyExecutor = defineProviderProxy(feishuProxyDefinition("lark", larkCloud));
