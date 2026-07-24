// ============================================================================
// C10: UX Production Safety Validation
// ============================================================================

// --- Form Error Structure ---

export type FormErrorCode =
  'MISSING_FIELD_PATH' | 'MISSING_ERROR_CODE' | 'MISSING_USER_MESSAGE' | 'INPUT_NOT_PRESERVED';

export interface FormErrorIssue {
  code: FormErrorCode;
  message: string;
}

export interface FormErrorInput {
  fieldPath: string;
  errorCode: string;
  userMessage: string;
  preservesUserInput: boolean;
}

export interface FormErrorResult {
  valid: boolean;
  issues: FormErrorIssue[];
}

export function validateFormErrors(input: FormErrorInput): FormErrorResult {
  const issues: FormErrorIssue[] = [];

  if (input.fieldPath.trim().length === 0) {
    issues.push({
      code: 'MISSING_FIELD_PATH',
      message: 'Form error must specify a field path.',
    });
  }

  if (input.errorCode.trim().length === 0) {
    issues.push({
      code: 'MISSING_ERROR_CODE',
      message: 'Form error must have an error code.',
    });
  }

  if (input.userMessage.trim().length === 0) {
    issues.push({
      code: 'MISSING_USER_MESSAGE',
      message: 'Form error must have a user-facing message.',
    });
  }

  if (!input.preservesUserInput) {
    issues.push({
      code: 'INPUT_NOT_PRESERVED',
      message: 'Form error must preserve user input.',
    });
  }

  return { valid: issues.length === 0, issues };
}

// --- Status Badge Accessibility ---

export type StatusBadgeIssueCode = 'COLOR_ONLY_INDICATOR' | 'MISSING_TEXT_LABEL';

export interface StatusBadgeIssue {
  code: StatusBadgeIssueCode;
  message: string;
}

export interface StatusBadgeInput {
  status: string;
  label: string;
  icon: string | null;
  colorOnly: boolean;
}

export interface StatusBadgeResult {
  accessible: boolean;
  issues: StatusBadgeIssue[];
}

export function validateStatusBadge(input: StatusBadgeInput): StatusBadgeResult {
  const issues: StatusBadgeIssue[] = [];

  if (input.colorOnly && input.icon === null) {
    issues.push({
      code: 'COLOR_ONLY_INDICATOR',
      message: 'Status badge must not rely on color alone; add icon or pattern.',
    });
  }

  if (input.label.trim().length === 0) {
    issues.push({
      code: 'MISSING_TEXT_LABEL',
      message: 'Status badge must have a text label for screen readers.',
    });
  }

  return { accessible: issues.length === 0, issues };
}

// --- Locale Validation ---

export type LocaleIssueCode = 'INVALID_LOCALE_FORMAT' | 'HARDCODED_LOCALE_IN_DOMAIN';

export interface LocaleIssue {
  code: LocaleIssueCode;
  message: string;
}

export interface LocaleInput {
  locale: string;
  market: string;
  contentLocale: string;
  hardcodedChineseInDomain?: boolean;
}

export interface LocaleResult {
  valid: boolean;
  issues: LocaleIssue[];
}

const LOCALE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;

export function validateLocale(input: LocaleInput): LocaleResult {
  const issues: LocaleIssue[] = [];

  if (!LOCALE_PATTERN.test(input.locale)) {
    issues.push({
      code: 'INVALID_LOCALE_FORMAT',
      message: `Locale "${input.locale}" does not match expected format (e.g., zh-CN, en-US).`,
    });
  }

  if (input.hardcodedChineseInDomain === true) {
    issues.push({
      code: 'HARDCODED_LOCALE_IN_DOMAIN',
      message: 'Domain content must not hardcode locale-specific text.',
    });
  }

  return { valid: issues.length === 0, issues };
}

// --- Empty State Honesty ---

export type EmptyStateIssueCode = 'FAKE_DATA_VISUALIZATION' | 'MISSING_NEXT_STEP';

export interface EmptyStateIssue {
  code: EmptyStateIssueCode;
  message: string;
}

export interface EmptyStateInput {
  hasData: boolean;
  showsPlaceholderChart: boolean;
  explainsNextStep: boolean;
  nextStepAction: string;
}

export interface EmptyStateResult {
  honest: boolean;
  issues: EmptyStateIssue[];
}

export function validateEmptyState(input: EmptyStateInput): EmptyStateResult {
  const issues: EmptyStateIssue[] = [];

  if (!input.hasData && input.showsPlaceholderChart) {
    issues.push({
      code: 'FAKE_DATA_VISUALIZATION',
      message: 'Empty state must not show fake or placeholder data visualizations.',
    });
  }

  if (!input.hasData && !input.explainsNextStep) {
    issues.push({
      code: 'MISSING_NEXT_STEP',
      message: 'Empty state must explain the next step to the user.',
    });
  }

  return { honest: issues.length === 0, issues };
}
