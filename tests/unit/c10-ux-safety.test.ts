import { describe, expect, it } from 'vitest';
import {
  validateFormErrors,
  validateStatusBadge,
  validateLocale,
  validateEmptyState,
  type FormErrorInput,
  type StatusBadgeInput,
  type LocaleInput,
  type EmptyStateInput,
} from '@aeostudio/domain/ux-safety';

describe('C10: UX Production Safety', () => {
  describe('Form error structure', () => {
    function makeFormErrorInput(overrides: Partial<FormErrorInput> = {}): FormErrorInput {
      return {
        fieldPath: 'profile.name',
        errorCode: 'REQUIRED_FIELD',
        userMessage: '此字段为必填项',
        preservesUserInput: true,
        ...overrides,
      };
    }

    it('accepts valid form error structure', () => {
      const result = validateFormErrors(makeFormErrorInput());
      expect(result.valid).toBe(true);
      expect(result.issues).toEqual([]);
    });

    it('rejects form error without field path', () => {
      const result = validateFormErrors(makeFormErrorInput({ fieldPath: '' }));
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.code === 'MISSING_FIELD_PATH')).toBe(true);
    });

    it('rejects form error without error code', () => {
      const result = validateFormErrors(makeFormErrorInput({ errorCode: '' }));
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.code === 'MISSING_ERROR_CODE')).toBe(true);
    });

    it('rejects form error without user message', () => {
      const result = validateFormErrors(makeFormErrorInput({ userMessage: '' }));
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.code === 'MISSING_USER_MESSAGE')).toBe(true);
    });

    it('rejects form error that does not preserve user input', () => {
      const result = validateFormErrors(makeFormErrorInput({ preservesUserInput: false }));
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.code === 'INPUT_NOT_PRESERVED')).toBe(true);
    });
  });

  describe('Status badge accessibility', () => {
    function makeStatusBadgeInput(overrides: Partial<StatusBadgeInput> = {}): StatusBadgeInput {
      return {
        status: 'ACTIVE',
        label: '活跃',
        icon: 'check-circle',
        colorOnly: false,
        ...overrides,
      };
    }

    it('accepts badge with label and icon', () => {
      const result = validateStatusBadge(makeStatusBadgeInput());
      expect(result.accessible).toBe(true);
      expect(result.issues).toEqual([]);
    });

    it('rejects badge relying only on color', () => {
      const result = validateStatusBadge(makeStatusBadgeInput({ colorOnly: true, icon: null }));
      expect(result.accessible).toBe(false);
      expect(result.issues.some((i) => i.code === 'COLOR_ONLY_INDICATOR')).toBe(true);
    });

    it('rejects badge without text label', () => {
      const result = validateStatusBadge(makeStatusBadgeInput({ label: '' }));
      expect(result.accessible).toBe(false);
      expect(result.issues.some((i) => i.code === 'MISSING_TEXT_LABEL')).toBe(true);
    });

    it('accepts badge with icon but no color dependency', () => {
      const result = validateStatusBadge(
        makeStatusBadgeInput({ colorOnly: false, icon: 'alert-triangle' }),
      );
      expect(result.accessible).toBe(true);
    });
  });

  describe('Locale validation', () => {
    function makeLocaleInput(overrides: Partial<LocaleInput> = {}): LocaleInput {
      return {
        locale: 'zh-CN',
        market: 'CN',
        contentLocale: 'zh-CN',
        ...overrides,
      };
    }

    it('accepts valid locale configuration', () => {
      const result = validateLocale(makeLocaleInput());
      expect(result.valid).toBe(true);
      expect(result.issues).toEqual([]);
    });

    it('accepts English locale', () => {
      const result = validateLocale(
        makeLocaleInput({ locale: 'en-US', market: 'US', contentLocale: 'en-US' }),
      );
      expect(result.valid).toBe(true);
    });

    it('rejects invalid locale format', () => {
      const result = validateLocale(makeLocaleInput({ locale: 'invalid' }));
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.code === 'INVALID_LOCALE_FORMAT')).toBe(true);
    });

    it('rejects hardcoded Chinese in domain content', () => {
      const result = validateLocale(
        makeLocaleInput({
          locale: 'en-US',
          contentLocale: 'en-US',
          hardcodedChineseInDomain: true,
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.code === 'HARDCODED_LOCALE_IN_DOMAIN')).toBe(true);
    });
  });

  describe('Empty state honesty', () => {
    function makeEmptyStateInput(overrides: Partial<EmptyStateInput> = {}): EmptyStateInput {
      return {
        hasData: false,
        showsPlaceholderChart: false,
        explainsNextStep: true,
        nextStepAction: '创建您的第一个 Profile',
        ...overrides,
      };
    }

    it('accepts honest empty state with next step', () => {
      const result = validateEmptyState(makeEmptyStateInput());
      expect(result.honest).toBe(true);
      expect(result.issues).toEqual([]);
    });

    it('rejects empty state showing fake chart', () => {
      const result = validateEmptyState(
        makeEmptyStateInput({ hasData: false, showsPlaceholderChart: true }),
      );
      expect(result.honest).toBe(false);
      expect(result.issues.some((i) => i.code === 'FAKE_DATA_VISUALIZATION')).toBe(true);
    });

    it('rejects empty state without next step explanation', () => {
      const result = validateEmptyState(makeEmptyStateInput({ explainsNextStep: false }));
      expect(result.honest).toBe(false);
      expect(result.issues.some((i) => i.code === 'MISSING_NEXT_STEP')).toBe(true);
    });

    it('accepts populated state without next step requirement', () => {
      const result = validateEmptyState(
        makeEmptyStateInput({ hasData: true, explainsNextStep: false }),
      );
      expect(result.honest).toBe(true);
    });
  });

  describe('Determinism', () => {
    it('same form error input produces same result', () => {
      const input: FormErrorInput = {
        fieldPath: 'profile.name',
        errorCode: 'REQUIRED_FIELD',
        userMessage: '此字段为必填项',
        preservesUserInput: true,
      };
      const result1 = validateFormErrors(input);
      const result2 = validateFormErrors(input);
      expect(result1).toEqual(result2);
    });

    it('same empty state input produces same result', () => {
      const input: EmptyStateInput = {
        hasData: false,
        showsPlaceholderChart: false,
        explainsNextStep: true,
        nextStepAction: '创建您的第一个 Profile',
      };
      const result1 = validateEmptyState(input);
      const result2 = validateEmptyState(input);
      expect(result1).toEqual(result2);
    });
  });
});
