import React from 'react';
import { Check, Copy, Download, FileCode2, Pencil, X } from 'lucide-react';
import type { GeneratedFile } from '../core/types';

/** Colour one line of YAML. Deliberately line-scoped: fast and good enough. */
function Line({ text }: { text: string }) {
  if (text.trim().startsWith('#')) return <span className="text-slate-500">{text || ' '}</span>;

  const match = /^(\s*)(-\s+)?([A-Za-z0-9_."'$/{][^:]*)(:)(\s?)(.*)$/.exec(text);
  if (!match) {
    const dash = /^(\s*)(-\s+)(.*)$/.exec(text);
    if (dash) {
      return (
        <>
          <span>{dash[1]}</span>
          <span className="text-slate-500">{dash[2]}</span>
          <Value text={dash[3]} />
        </>
      );
    }
    return <Value text={text} />;
  }
  const [, indent, dash, key, colon, space, rest] = match;
  return (
    <>
      <span>{indent}</span>
      {dash && <span className="text-slate-500">{dash}</span>}
      <span className="text-teal-300">{key}</span>
      <span className="text-slate-500">{colon}</span>
      <span>{space}</span>
      <Value text={rest} />
    </>
  );
}

function Value({ text }: { text: string }) {
  if (text === '') return <span> </span>;
  if (/^\{\{|\{\{/.test(text.trim())) return <span className="text-fuchsia-300">{text}</span>;
  if (/^['"]/.test(text.trim())) return <span className="text-amber-200">{text}</span>;
  if (/^(true|false|null|\d[\d.]*)$/.test(text.trim())) return <span className="text-violet-300">{text}</span>;
  if (text.trim().startsWith('|') || text.trim().startsWith('>')) return <span className="text-slate-400">{text}</span>;
  return <span className="text-slate-100">{text}</span>;
}

interface Props {
  files: GeneratedFile[];
  activeIndex: number;
  onSelect: (index: number) => void;
  editing: boolean;
  draft: string;
  editError: string | null;
  onDraftChange: (value: string) => void;
  onToggleEdit: () => void;
  onCopy: () => void;
  onDownload: () => void;
  onDownloadAll: () => void;
  copied: boolean;
}

export function YamlPane({
  files, activeIndex, onSelect, editing, draft, editError,
  onDraftChange, onToggleEdit, onCopy, onDownload, onDownloadAll, copied,
}: Props) {
  const active = files[activeIndex] ?? files[0];
  const content = editing ? draft : active?.content ?? '';
  const lines = content.split('\n');

  return (
    <div className="flex h-full flex-col" style={{ background: 'rgba(3,7,16,0.72)' }}>
      <div className="flex items-center justify-between gap-2 border-b border-slate-800 px-3 py-2">
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
          {files.map((file, index) => (
            <button
              key={file.path}
              type="button"
              onClick={() => onSelect(index)}
              className={`flex shrink-0 items-center gap-1.5 rounded px-2 py-1 font-mono text-xs transition-colors ${
                index === activeIndex
                  ? 'bg-slate-800 text-teal-200'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              }`}
            >
              <FileCode2 className="h-3 w-3" />
              {file.path}
            </button>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onToggleEdit}
            title={editing ? 'Close the editor' : 'Edit this file and update the form'}
            className={`rounded p-1.5 transition-colors ${
              editing ? 'bg-teal-600 text-white' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'
            }`}
          >
            {editing ? <X className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
          </button>
          <button type="button" onClick={onCopy} title="Copy this file" className="rounded p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100">
            {copied ? <Check className="h-4 w-4 text-teal-300" /> : <Copy className="h-4 w-4" />}
          </button>
          <button type="button" onClick={onDownload} title="Download this file" className="rounded p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100">
            <Download className="h-4 w-4" />
          </button>
          {files.length > 1 && (
            <button
              type="button"
              onClick={onDownloadAll}
              className="rounded border border-slate-600 px-2 py-1 font-mono text-xs uppercase tracking-wider text-slate-300 transition-colors hover:border-teal-500 hover:text-teal-200"
            >
              zip
            </button>
          )}
        </div>
      </div>

      {editing && (
        <div className={`border-b px-3 py-1.5 text-xs ${editError ? 'border-rose-900 bg-rose-950 text-rose-200' : 'border-slate-700 bg-slate-800 text-slate-300'}`}>
          {editError ?? 'Edits here are parsed straight back into the form.'}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {editing ? (
          <textarea
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            spellCheck={false}
            className="h-full w-full resize-none bg-transparent p-3 font-mono text-xs leading-relaxed text-slate-100 focus:outline-none"
          />
        ) : (
          <pre className="p-3 font-mono text-xs leading-relaxed">
            {lines.map((line, index) => (
              <div key={index} className="flex">
                <span className="mr-3 w-8 shrink-0 select-none text-right text-slate-600">{index + 1}</span>
                <span className="whitespace-pre-wrap break-all">
                  <Line text={line} />
                </span>
              </div>
            ))}
          </pre>
        )}
      </div>
    </div>
  );
}
