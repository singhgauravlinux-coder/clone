import React, { useRef, useState } from 'react';
import { Upload, X } from 'lucide-react';
import { surface } from '../theme';

const glass = surface.glass;

interface Props {
  open: boolean;
  onClose: () => void;
  onImport: (text: string) => string | null;
}

export function ImportDialog({ open, onClose, onImport }: Props) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  if (!open) return null;

  const submit = (value: string) => {
    const failure = onImport(value);
    if (failure) setError(failure);
    else {
      setText('');
      setError(null);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center p-0 sm:items-center sm:p-6" style={{ background: 'rgba(2,6,14,0.72)' }}>
      <div style={glass} className="flex max-h-full w-full max-w-2xl flex-col rounded-t-2xl sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
          <h2 className="font-mono text-sm uppercase tracking-widest text-slate-400">Import YAML</h2>
          <button type="button" onClick={onClose} className="rounded p-1 text-slate-400 transition-colors hover:text-slate-100">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <p className="mb-3 text-sm text-slate-400">
            Paste a manifest, a multi-document file, a kustomization, or a workflow. The matching form opens with
            the values filled in. Fields this app does not model are dropped, so compare the preview before you save.
          </p>
          <textarea
            value={text}
            onChange={(event) => { setText(event.target.value); setError(null); }}
            rows={12}
            spellCheck={false}
            placeholder={'apiVersion: apps/v1\nkind: Deployment\n...'}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 font-mono text-xs text-slate-100 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
          />
          {error && (
            <p className="mt-2 rounded-lg border border-rose-800 px-3 py-2 text-sm text-rose-200" style={{ background: 'rgba(244,63,94,0.10)' }}>{error}</p>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-slate-800 px-4 py-3">
          <input
            ref={fileInput}
            type="file"
            accept=".yaml,.yml,.txt"
            className="hidden"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              const content = await file.text();
              setText(content);
              setError(null);
            }}
          />
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200 transition-colors hover:border-teal-500 hover:text-teal-300"
          >
            <Upload className="h-4 w-4" /> Choose a file
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-slate-400 transition-colors hover:text-slate-100">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => submit(text)}
              disabled={!text.trim()}
              className="rounded-lg bg-teal-500 px-4 py-2 text-sm font-medium text-slate-950 transition-colors hover:bg-teal-400 disabled:bg-slate-700 disabled:text-slate-500"
            >
              Load into form
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
