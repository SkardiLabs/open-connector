import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";

import { createFeishuProviderModule } from "../feishu/executors.ts";
import { larkCloud } from "../feishu/shared/cloud.ts";
import { larkActions } from "./actions.ts";

const larkModule = createFeishuProviderModule({ service: "lark", actions: larkActions, cloud: larkCloud });

export const executors: ProviderExecutors = larkModule.executors;
export const credentialValidators: CredentialValidators = larkModule.credentialValidators;
