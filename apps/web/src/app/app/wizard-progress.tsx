'use client';

import type { Locale, MessageKey } from '../../lib/i18n';
import { makeT } from '../../lib/i18n';

export type WizardStepId =
  'start' | 'company' | 'products' | 'audiences' | 'evidence' | 'strategy' | 'channels' | 'content';

export const WIZARD_STEPS: readonly WizardStepId[] = [
  'start',
  'company',
  'products',
  'audiences',
  'evidence',
  'strategy',
  'channels',
  'content',
] as const;

const STEP_LABEL_KEYS: Record<WizardStepId, MessageKey> = {
  start: 'nav.wizard.start',
  company: 'nav.wizard.company',
  products: 'nav.wizard.products',
  audiences: 'nav.wizard.audiences',
  evidence: 'nav.wizard.evidence',
  strategy: 'nav.wizard.strategy',
  channels: 'nav.wizard.channels',
  content: 'nav.wizard.content',
};

interface WizardProgressProps {
  locale: Locale;
  currentStep: WizardStepId;
  completedSteps?: WizardStepId[];
  contextQuery: string;
}

export function WizardProgress({
  locale,
  currentStep,
  completedSteps = [],
  contextQuery,
}: WizardProgressProps) {
  const t = makeT(locale);
  const currentIndex = WIZARD_STEPS.indexOf(currentStep);
  const progressPercent = Math.round((currentIndex / (WIZARD_STEPS.length - 1)) * 100);

  return (
    <nav
      className="wizard-progress"
      aria-label={t('wizard.progress', {
        current: String(currentIndex + 1),
        total: String(WIZARD_STEPS.length),
      })}
    >
      <div className="wizard-progress-bar">
        <div
          className="wizard-progress-fill"
          style={{ width: `${progressPercent}%` }}
          role="progressbar"
          aria-valuenow={currentIndex + 1}
          aria-valuemin={1}
          aria-valuemax={WIZARD_STEPS.length}
        />
      </div>
      <ol className="wizard-steps">
        {WIZARD_STEPS.map((stepId, index) => {
          const isCompleted = completedSteps.includes(stepId);
          const isCurrent = stepId === currentStep;
          const isLocked = index > currentIndex && !isCompleted;
          const statusClass = isCurrent
            ? 'wizard-step current'
            : isCompleted
              ? 'wizard-step completed'
              : isLocked
                ? 'wizard-step locked'
                : 'wizard-step';

          return (
            <li key={stepId} className={statusClass}>
              {isLocked ? (
                <span className="wizard-step-label" aria-disabled="true">
                  <span className="wizard-step-number">{index + 1}</span>
                  <span className="wizard-step-text">{t(STEP_LABEL_KEYS[stepId])}</span>
                </span>
              ) : (
                <a
                  href={`/app/${stepId === 'start' ? 'start' : stepId}${contextQuery}`}
                  className="wizard-step-label"
                  aria-current={isCurrent ? 'step' : undefined}
                >
                  <span className="wizard-step-number">{isCompleted ? '✓' : index + 1}</span>
                  <span className="wizard-step-text">{t(STEP_LABEL_KEYS[stepId])}</span>
                </a>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
