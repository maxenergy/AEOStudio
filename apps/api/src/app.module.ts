import { Module, type DynamicModule } from '@nestjs/common';
import type { JobTraceContextProvider } from '@aeostudio/application/jobs-budgets';
import type { StructuredApplicationLogger } from '@aeostudio/adapters/observability';
import type { RuntimeBuildIdentity } from '@aeostudio/adapters';

import { ArtifactsModule, type ArtifactsModuleOptions } from './artifacts/artifacts.module.js';
import { AuthModule, type AuthModuleOptions } from './auth/auth.module.js';
import { ChannelsModule, type ChannelsModuleOptions } from './channels/channels.module.js';
import { ClaimsModule, type ClaimsModuleOptions } from './claims/claims.module.js';
import {
  ContentPlansModule,
  type ContentPlansModuleOptions,
} from './content-plans/content-plans.module.js';
import { HealthModule } from './health/health.module.js';
import {
  ExperimentsModule,
  type ExperimentsModuleOptions,
} from './experiments/experiments.module.js';
import { JobsModule, type JobsModuleOptions } from './jobs/jobs.module.js';
import {
  MeasurementModule,
  type MeasurementModuleOptions,
} from './measurement/measurement.module.js';
import { OnboardingModule, type OnboardingModuleOptions } from './onboarding/onboarding.module.js';
import {
  ProfileOfferingModule,
  type ProfileOfferingModuleOptions,
} from './profile-offering/profile-offering.module.js';
import { ObservabilityModule } from './observability/observability.module.js';
import { PromptsModule, type PromptsModuleOptions } from './prompts/prompts.module.js';
import { PrivacyModule, type PrivacyModuleOptions } from './privacy/privacy.module.js';
import { RuntimeModule } from './runtime/runtime.module.js';
import { SitesModule, type SitesModuleOptions } from './sites/sites.module.js';
import { TenancyModule, type TenancyModuleOptions } from './tenants/tenancy.module.js';

export interface ApiAppOptions
  extends
    ArtifactsModuleOptions,
    AuthModuleOptions,
    ChannelsModuleOptions,
    ClaimsModuleOptions,
    ContentPlansModuleOptions,
    TenancyModuleOptions,
    OnboardingModuleOptions,
    ProfileOfferingModuleOptions,
    PromptsModuleOptions,
    JobsModuleOptions,
    MeasurementModuleOptions,
    ExperimentsModuleOptions,
    SitesModuleOptions,
    PrivacyModuleOptions {
  cleanup?: () => Promise<void>;
  readiness?: () => Promise<boolean>;
  jobTraceContextProvider?: JobTraceContextProvider;
  applicationLogger?: StructuredApplicationLogger;
  runtimeBuildIdentity?: RuntimeBuildIdentity | null;
}

@Module({})
export class AppModule {
  static register(options: ApiAppOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ObservabilityModule.register(options.jobTraceContextProvider, options.applicationLogger),
        ArtifactsModule.register(options),
        AuthModule.register(options),
        ChannelsModule.register(options),
        ClaimsModule.register(options),
        ContentPlansModule.register(options),
        HealthModule.register(options.readiness ?? (() => Promise.resolve(true))),
        ExperimentsModule.register(options),
        RuntimeModule.register(
          options.cleanup ?? (() => Promise.resolve()),
          options.runtimeBuildIdentity ?? null,
        ),
        TenancyModule.register(options),
        ProfileOfferingModule.register(options),
        PrivacyModule.register(options),
        PromptsModule.register(options),
        JobsModule.register(options),
        MeasurementModule.register(options),
        OnboardingModule.register(options),
        SitesModule.register(options),
      ],
    };
  }
}
