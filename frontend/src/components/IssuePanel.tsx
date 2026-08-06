import React from 'react';
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import type { Issue } from '../core/types';
import { fieldId } from './FormRenderer';

export function focusField(path?: string) {
  if (!path) return;
  const element = document.getElementById(fieldId(path));
  if (!element) return;
  element.scrollIntoView({ block: 'center', behavior: 'smooth' });
  if (element instanceof HTMLElement) {
    element.focus({ preventScroll: true });
    element.classList.add('ring-2', 'ring-amber-400');
    window.setTimeout(() => element.classList.remove('ring-2', 'ring-amber-400'), 1200);
  }
}

export function IssuePanel({ issues }: { issues: Issue[] }) {
  if (!issues.length) {
    return (
      <div
        className="flex items-center gap-2 rounded-xl border border-teal-700 px-3 py-2 text-sm text-teal-200"
        style={{ background: 'rgba(45,212,191,0.10)' }}
      >
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        Valid. Nothing to fix.
      </div>
    );
  }
  return (
    <ul className="space-y-1.5">
      {issues.map((issue, index) => {
        const error = issue.level === 'error';
        return (
          <li key={index}>
            <button
              type="button"
              onClick={() => focusField(issue.path)}
              style={{ background: error ? 'rgba(244,63,94,0.10)' : 'rgba(251,191,36,0.09)' }}
              className={`flex w-full items-start gap-2 rounded-xl border px-3 py-2 text-left text-sm transition-colors ${
                error
                  ? 'border-rose-800 text-rose-200 hover:border-rose-500'
                  : 'border-amber-800 text-amber-200 hover:border-amber-500'
              }`}
            >
              {error
                ? <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
                : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />}
              <span className="min-w-0">
                <span className="block leading-snug">{issue.message}</span>
                {issue.path && (
                  <span className="mt-0.5 block truncate font-mono text-xs opacity-70">{issue.path}</span>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
