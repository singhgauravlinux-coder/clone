import React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { FieldDef, Model } from '../core/types';
import { get, set } from '../core/model';

export function fieldId(path: string): string {
  return `field-${path.replace(/[.[\]]/g, '-')}`;
}

const label = 'block font-mono text-xs uppercase tracking-widest text-slate-400';
const control = 'w-full rounded-lg border bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 transition-colors focus:outline-none focus:ring-1';
const calm = 'border-slate-700 focus:border-teal-500 focus:ring-teal-500';
const flagged = 'border-rose-500 focus:border-rose-400 focus:ring-rose-400';

interface RenderProps {
  fields: FieldDef[];
  model: Model;
  prefix: string;
  errors: Set<string>;
  onChange: (path: string, value: any) => void;
}

function Help({ text }: { text?: string }) {
  if (!text) return null;
  return <p className="mt-1 text-xs leading-snug text-slate-500">{text}</p>;
}

function Toggle({ id, value, onChange }: { id: string; value: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors focus:outline-none focus:ring-2 focus:ring-teal-600 focus:ring-offset-1 ${
        value ? 'border-teal-400 bg-teal-500' : 'border-slate-700 bg-slate-800'
      }`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${value ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  );
}

function KeyValueRows({ id, rows, keyLabel, valueLabel, onChange }: {
  id: string;
  rows: { key: string; value: string }[];
  keyLabel?: string;
  valueLabel?: string;
  onChange: (next: { key: string; value: string }[]) => void;
}) {
  const list = Array.isArray(rows) ? rows : [];
  return (
    <div className="space-y-2">
      {list.map((row, index) => (
        <div key={index} className="flex gap-2">
          <input
            id={index === 0 ? id : undefined}
            value={row?.key ?? ''}
            placeholder={keyLabel ?? 'key'}
            onChange={(event) => onChange(list.map((item, i) => (i === index ? { ...item, key: event.target.value } : item)))}
            className={`${control} ${calm} font-mono`}
          />
          <input
            value={row?.value ?? ''}
            placeholder={valueLabel ?? 'value'}
            onChange={(event) => onChange(list.map((item, i) => (i === index ? { ...item, value: event.target.value } : item)))}
            className={`${control} ${calm} font-mono`}
          />
          <button
            type="button"
            aria-label="Remove row"
            onClick={() => onChange(list.filter((_, i) => i !== index))}
            className="shrink-0 rounded-lg border border-slate-700 px-2 text-slate-400 transition-colors hover:border-rose-500 hover:text-rose-300"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...list, { key: '', value: '' }])}
        className="inline-flex items-center gap-1 rounded-lg border border-dashed border-slate-700 px-2 py-1 font-mono text-xs uppercase tracking-wider text-slate-400 transition-colors hover:border-teal-500 hover:text-teal-300"
      >
        <Plus className="h-3 w-3" /> add
      </button>
    </div>
  );
}

function StringList({ id, field, value, onChange }: {
  id: string; field: FieldDef; value: any; onChange: (next: any) => void;
}) {
  const list: string[] = Array.isArray(value) ? value : [];
  if (field.options?.length) {
    return (
      <div id={id} className="flex flex-wrap gap-2">
        {field.options.map((option) => {
          const on = list.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              title={option.help}
              onClick={() => onChange(on ? list.filter((item) => item !== option.value) : [...list, option.value])}
              className={`rounded-full border px-3 py-1 font-mono text-xs transition-colors ${
                on
                  ? 'border-teal-400 bg-teal-600 text-white'
                  : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-teal-500 hover:text-teal-300'
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    );
  }
  return (
    <textarea
      id={id}
      rows={3}
      value={list.join('\n')}
      placeholder={field.placeholder}
      onChange={(event) => onChange(event.target.value.split('\n').filter((line) => line.trim() !== ''))}
      className={`${control} ${calm} font-mono`}
    />
  );
}

function ArrayField({ field, path, rows, errors, onReplace }: {
  field: FieldDef;
  path: string;
  rows: Model[];
  errors: Set<string>;
  onReplace: (next: Model[]) => void;
}) {
  const list = Array.isArray(rows) ? rows : [];
  return (
    <div className="space-y-3">
      {list.map((row, index) => (
        <div key={index} className="rounded-xl border border-slate-800 bg-slate-900 p-3">
          <div className="mb-3 flex items-center justify-between">
            <span className="font-mono text-xs uppercase tracking-wider text-slate-500">
              {field.itemLabel ?? 'item'} {index + 1}
            </span>
            <button
              type="button"
              onClick={() => onReplace(list.filter((_, i) => i !== index))}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-400 transition-colors hover:border-rose-500 hover:text-rose-300"
            >
              <Trash2 className="h-3 w-3" /> Remove
            </button>
          </div>
          <FormRenderer
            fields={field.itemFields ?? []}
            model={row ?? {}}
            prefix={`${path}.${index}.`}
            errors={errors}
            onChange={(childPath, value) => {
              const relative = childPath.slice(`${path}.${index}.`.length);
              onReplace(list.map((item, i) => (i === index ? set(item ?? {}, relative, value) : item)));
            }}
          />
        </div>
      ))}
      <button
        type="button"
        onClick={() => onReplace([...list, field.itemDefault ? field.itemDefault() : {}])}
        className="inline-flex items-center gap-1 rounded-lg border border-dashed border-slate-700 px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-slate-400 transition-colors hover:border-teal-500 hover:text-teal-300"
      >
        <Plus className="h-3 w-3" /> add {field.itemLabel ?? 'item'}
      </button>
    </div>
  );
}

function Field({ field, model, prefix, errors, onChange }: RenderProps & { field: FieldDef }) {
  const fullPath = `${prefix}${field.path}`;
  const id = fieldId(fullPath);
  const value = get(model, field.path);
  const invalid = errors.has(fullPath);
  const ring = invalid ? flagged : calm;
  const mono = field.mono ? 'font-mono' : '';

  const body = (() => {
    switch (field.kind) {
      case 'boolean':
        return <Toggle id={id} value={value === true} onChange={(next) => onChange(fullPath, next)} />;
      case 'select':
        return (
          <select
            id={id}
            value={value ?? ''}
            onChange={(event) => onChange(fullPath, event.target.value)}
            className={`${control} ${ring} ${mono}`}
          >
            {(field.options ?? []).map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        );
      case 'number':
        return (
          <input
            id={id}
            type="number"
            value={value ?? ''}
            min={field.min}
            max={field.max}
            step={field.step}
            placeholder={field.placeholder}
            onChange={(event) => onChange(fullPath, event.target.value === '' ? '' : Number(event.target.value))}
            className={`${control} ${ring} font-mono`}
          />
        );
      case 'textarea':
        return (
          <textarea
            id={id}
            rows={4}
            value={value ?? ''}
            placeholder={field.placeholder}
            onChange={(event) => onChange(fullPath, event.target.value)}
            className={`${control} ${ring} ${mono}`}
          />
        );
      case 'keyvalue':
        return (
          <KeyValueRows
            id={id}
            rows={value}
            keyLabel={field.keyLabel}
            valueLabel={field.valueLabel}
            onChange={(next) => onChange(fullPath, next)}
          />
        );
      case 'stringlist':
        return <StringList id={id} field={field} value={value} onChange={(next) => onChange(fullPath, next)} />;
      case 'array':
        return (
          <ArrayField
            field={field}
            path={fullPath}
            rows={value}
            errors={errors}
            onReplace={(next) => onChange(fullPath, next)}
          />
        );
      default:
        return (
          <input
            id={id}
            type="text"
            value={value ?? ''}
            placeholder={field.placeholder}
            onChange={(event) => onChange(fullPath, event.target.value)}
            className={`${control} ${ring} ${mono}`}
          />
        );
    }
  })();

  const inline = field.kind === 'boolean';
  return (
    <div className={field.half && !inline ? 'sm:col-span-1' : 'sm:col-span-2'}>
      <div className={inline ? 'flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2' : ''}>
        <label htmlFor={id} className={inline ? 'text-sm text-slate-200' : label}>
          {field.label}
          {field.required && <span className="ml-1 text-rose-500">*</span>}
        </label>
        {inline ? body : <div className="mt-1.5">{body}</div>}
      </div>
      <Help text={field.help} />
    </div>
  );
}

export function FormRenderer({ fields, model, prefix, errors, onChange }: RenderProps) {
  const visible = fields.filter((field) => !field.when || field.when(model));
  if (prefix !== '') {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {visible.map((field) => (
          <Field key={field.path} field={field} fields={fields} model={model} prefix={prefix} errors={errors} onChange={onChange} />
        ))}
      </div>
    );
  }

  const sections: { name: string; fields: FieldDef[] }[] = [];
  visible.forEach((field) => {
    const name = field.section ?? 'General';
    const existing = sections.find((section) => section.name === name);
    if (existing) existing.fields.push(field);
    else sections.push({ name, fields: [field] });
  });

  return (
    <div className="space-y-8">
      {sections.map((section) => (
        <section key={section.name} aria-label={section.name}>
          <h3 className="mb-3 flex items-center gap-3 font-mono text-xs uppercase tracking-widest text-slate-500">
            {section.name}
            <span className="h-px flex-1 bg-slate-800" />
          </h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {section.fields.map((field) => (
              <Field key={field.path} field={field} fields={fields} model={model} prefix={prefix} errors={errors} onChange={onChange} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
