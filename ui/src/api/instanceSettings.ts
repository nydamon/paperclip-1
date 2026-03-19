import type {
  InstanceExperimentalSettings,
  PatchInstanceExperimentalSettings,
} from "@paperclipai_dld/shared";
import { api } from "./client";

export const instanceSettingsApi = {
  getExperimental: () =>
    api.get<InstanceExperimentalSettings>("/instance/settings/experimental"),
  updateExperimental: (patch: PatchInstanceExperimentalSettings) =>
    api.patch<InstanceExperimentalSettings>("/instance/settings/experimental", patch),
};
