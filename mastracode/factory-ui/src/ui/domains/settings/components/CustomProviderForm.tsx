import { Button } from '@mastra/playground-ui/components/Button';
import { Field, FieldLabel } from '@mastra/playground-ui/components/Field';
import { Input } from '@mastra/playground-ui/components/Input';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useState } from 'react';

import type { CustomProviderInfo, SaveCustomProviderBody } from '../../../../api/types';
import { useSaveCustomProvider } from '../../../../hooks/use-custom-providers';

interface DraftState {
  name: string;
  url: string;
  apiKey: string;
  models: string;
  /** fork(claude-agent): each model's context window as typed, by model name. */
  contextWindows: Record<string, string>;
}

function modelNames(models: string): string[] {
  return models
    .split(',')
    .map(model => model.trim())
    .filter(Boolean);
}

export interface CustomProviderFormProps {
  provider?: CustomProviderInfo;
  requireModels?: boolean;
  onCancel?: () => void;
  onSaved?: (provider: CustomProviderInfo) => void;
}

export function CustomProviderForm({ provider, requireModels = false, onCancel, onSaved }: CustomProviderFormProps) {
  const saveMutation = useSaveCustomProvider();
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState>({
    name: provider?.name ?? '',
    url: provider?.url ?? '',
    apiKey: '',
    models: provider?.models.join(', ') ?? '',
    contextWindows: Object.fromEntries(
      Object.entries(provider?.contextWindows ?? {}).map(([model, tokens]) => [model, String(tokens)]),
    ),
  });
  const listedModels = modelNames(draft.models);

  const save = async () => {
    const name = draft.name.trim();
    const url = draft.url.trim();
    if (!name || !url) {
      setError('Name and URL are required.');
      return;
    }

    const models = modelNames(draft.models);
    if (requireModels && models.length === 0) {
      setError('At least one model is required.');
      return;
    }
    // fork(claude-agent): a window left blank is read from the provider's model list on save.
    const contextWindows: Record<string, number> = {};
    for (const model of models) {
      const typed = draft.contextWindows[model]?.trim().replaceAll(',', '').replaceAll('_', '');
      if (!typed) continue;
      const tokens = Number(typed);
      if (!Number.isInteger(tokens) || tokens <= 0) {
        setError(`The context window for ${model} must be a whole number of tokens.`);
        return;
      }
      contextWindows[model] = tokens;
    }

    const apiKey = draft.apiKey.trim();
    const body: SaveCustomProviderBody = {
      name,
      url,
      models,
      ...(Object.keys(contextWindows).length > 0 ? { contextWindows } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(provider ? { previousId: provider.id } : {}),
    };

    setError(null);
    try {
      const result = await saveMutation.mutateAsync(body);
      onSaved?.(result.provider);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <Txt as="p" variant="caption" className="text-destructive-foreground">
          {error}
        </Txt>
      )}
      <Field className="gap-1">
        <FieldLabel>Name</FieldLabel>
        <Input
          size="sm"
          placeholder="e.g. my-llm"
          value={draft.name}
          onChange={event => setDraft({ ...draft, name: event.target.value })}
          autoFocus
        />
      </Field>
      <Field className="gap-1">
        <FieldLabel>Base URL</FieldLabel>
        <Input
          size="sm"
          placeholder="https://api.example.com/v1"
          value={draft.url}
          onChange={event => setDraft({ ...draft, url: event.target.value })}
        />
      </Field>
      <Field className="gap-1">
        <FieldLabel>API key {provider ? '(leave blank to keep)' : '(optional)'}</FieldLabel>
        <Input
          type="password"
          size="sm"
          placeholder="Paste API key"
          value={draft.apiKey}
          onChange={event => setDraft({ ...draft, apiKey: event.target.value })}
        />
      </Field>
      <Field className="gap-1">
        <FieldLabel>Models (comma-separated)</FieldLabel>
        <Input
          size="sm"
          placeholder="model-a, model-b"
          value={draft.models}
          onChange={event => setDraft({ ...draft, models: event.target.value })}
        />
      </Field>
      {/* fork(claude-agent): the composer's context meter fills against these. */}
      {listedModels.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1">
            <Txt as="span" variant="caption" tone="muted">
              Context window in tokens. Leave blank to read it from the provider&apos;s model list when you save.
            </Txt>
          </legend>
          {listedModels.map(model => (
            <Field key={model} className="gap-1">
              <FieldLabel>{model} context window</FieldLabel>
              <Input
                size="sm"
                inputMode="numeric"
                placeholder="e.g. 131072"
                value={draft.contextWindows[model] ?? ''}
                onChange={event =>
                  setDraft({ ...draft, contextWindows: { ...draft.contextWindows, [model]: event.target.value } })
                }
              />
            </Field>
          ))}
        </fieldset>
      )}
      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" disabled={saveMutation.isPending} onClick={() => void save()}>
          {saveMutation.isPending && <Spinner size="sm" aria-hidden className="size-3" />}
          {provider ? 'Save' : 'Add'}
        </Button>
        {onCancel && (
          <Button size="sm" disabled={saveMutation.isPending} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}
