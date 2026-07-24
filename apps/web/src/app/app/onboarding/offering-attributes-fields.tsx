'use client';

import type { OfferingEnvelope } from '@aeostudio/contracts';
import { useState } from 'react';

type OfferingAttribute = OfferingEnvelope['data']['offering']['attributes'][number];

/** 结构化业务字段已单独编辑，从通用维度编辑器中排除 */
const EXCLUDED_KEYS = new Set([
  'industry',
  'company_size',
  'competitors',
  'aeo_target_keywords',
  'geo_target_engines',
  'optimization_goals',
]);

interface AttributeRow {
  id: number;
  key: string;
  label: string;
  valueType: OfferingAttribute['valueType'];
  value: string;
}

function editableValue(attribute: OfferingAttribute): string {
  if (Array.isArray(attribute.value)) return attribute.value.join(', ');
  return String(attribute.value);
}

function initialRows(attributes: readonly OfferingAttribute[]): AttributeRow[] {
  const filtered = attributes.filter((attribute) => !EXCLUDED_KEYS.has(attribute.key));
  if (filtered.length === 0) {
    return [{ id: 0, key: '', label: '', valueType: 'text', value: '' }];
  }
  return filtered.map((attribute, index) => ({
    id: index,
    key: attribute.key,
    label: attribute.label,
    valueType: attribute.valueType,
    value: editableValue(attribute),
  }));
}

export function OfferingAttributesFields({
  initialAttributes = [],
}: {
  initialAttributes?: readonly OfferingAttribute[];
}) {
  const [rows, setRows] = useState(() => initialRows(initialAttributes));
  const [nextId, setNextId] = useState(rows.length);

  function addRow() {
    setRows((current) => [
      ...current,
      { id: nextId, key: '', label: '', valueType: 'text', value: '' },
    ]);
    setNextId((current) => current + 1);
  }

  function removeRow(id: number) {
    setRows((current) => current.filter((row) => row.id !== id));
  }

  return (
    <>
      <h3>自定义维度</h3>
      {rows.map((row, index) => {
        const position = index + 1;
        const suffix = position === 1 ? '' : ` ${position}`;
        return (
          <fieldset key={row.id}>
            <legend>自定义维度 {position}</legend>
            <label htmlFor={`attribute-key-${row.id}`}>自定义维度 Key{suffix}</label>
            <input
              defaultValue={row.key}
              id={`attribute-key-${row.id}`}
              name="attributeKey"
              pattern="[a-z][a-z0-9_]*"
            />
            <label htmlFor={`attribute-label-${row.id}`}>自定义维度名称{suffix}</label>
            <input
              defaultValue={row.label}
              id={`attribute-label-${row.id}`}
              name="attributeLabel"
            />
            <label htmlFor={`attribute-type-${row.id}`}>自定义维度类型{suffix}</label>
            <select
              defaultValue={row.valueType}
              id={`attribute-type-${row.id}`}
              name="attributeType"
            >
              <option value="text">文字</option>
              <option value="number">数字</option>
              <option value="boolean">布尔</option>
              <option value="url">URL</option>
              <option value="string_list">文字列表</option>
            </select>
            <label htmlFor={`attribute-value-${row.id}`}>自定义维度值{suffix}</label>
            <input
              defaultValue={row.value}
              id={`attribute-value-${row.id}`}
              name="attributeValue"
            />
            {rows.length === 1 ? null : (
              <button className="secondary-button" onClick={() => removeRow(row.id)} type="button">
                删除自定义维度 {position}
              </button>
            )}
          </fieldset>
        );
      })}
      <button className="secondary-button" onClick={addRow} type="button">
        添加自定义维度
      </button>
    </>
  );
}
