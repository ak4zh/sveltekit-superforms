import {
  enhance,
  applyAction,
  type MaybePromise,
  type SubmitFunction
} from '$app/forms';
import { beforeNavigate, invalidateAll } from '$app/navigation';
import { page } from '$app/stores';
import type { ActionResult } from '@sveltejs/kit';
import type { Page } from '@sveltejs/kit';
import { isElementInViewport, scrollToAndCenter } from './elements.js';
import {
  derived,
  get,
  writable,
  type Readable,
  type Writable,
  type Updater
} from 'svelte/store';
import { onDestroy, tick } from 'svelte';
import { browser } from '$app/environment';
import {
  SuperFormError,
  type TaintedFields,
  type Validation,
  type ValidationErrors,
  type Validator,
  type Validators,
  type FieldPath,
  type UnwrapEffects,
  type ZodValidation
} from '../index.js';
import type { z, AnyZodObject, ZodEffects, ZodArray, ZodTypeAny } from 'zod';
import { stringify } from 'devalue';
import type { FormFields } from '../index.js';
import {
  mapErrors,
  traversePath,
  findErrors,
  traversePathsAsync,
  comparePaths,
  setPaths,
  pathExists,
  type ZodTypeInfo,
  traversePaths
} from '../entity.js';
import { fieldProxy } from './proxies.js';
import { clone } from '../utils.js';
import { hasEffects, type Entity } from '../schemaEntity.js';
import { unwrapZodType } from '../schemaEntity.js';

enum FetchStatus {
  Idle = 0,
  Submitting = 1,
  Delayed = 2,
  Timeout = 3
}

export {
  jsonProxy,
  intProxy,
  numberProxy,
  booleanProxy,
  dateProxy,
  fieldProxy,
  formFieldProxy
} from './proxies.js';

export {
  superValidate,
  actionResult,
  message,
  setMessage,
  setError,
  defaultData
} from '../validate.js';

type FormUpdate = (
  result: Exclude<ActionResult, { type: 'error' }>,
  untaint?: boolean
) => Promise<void>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FormOptions<T extends ZodValidation<AnyZodObject>, M> = Partial<{
  id: string;
  applyAction: boolean;
  invalidateAll: boolean;
  resetForm: boolean | (() => MaybePromise<boolean>);
  scrollToError: 'auto' | 'smooth' | 'off';
  autoFocusOnError: boolean | 'detect';
  errorSelector: string;
  selectErrorText: boolean;
  stickyNavbar: string;
  taintedMessage: string | false | null;
  SPA: true | { failStatus?: number };

  onSubmit: (
    ...params: Parameters<SubmitFunction>
  ) => MaybePromise<unknown | void>;
  onResult: (event: {
    result: ActionResult;
    formEl: HTMLFormElement;
    cancel: () => void;
  }) => MaybePromise<unknown | void>;
  onUpdate: (event: {
    form: Validation<UnwrapEffects<T>, M>;
    cancel: () => void;
  }) => MaybePromise<unknown | void>;
  onUpdated: (event: {
    form: Readonly<Validation<UnwrapEffects<T>, M>>;
  }) => MaybePromise<unknown | void>;
  onError:
    | 'apply'
    | ((event: {
        result: {
          type: 'error';
          status?: number;
          error: App.Error;
        };
        message: Writable<Validation<UnwrapEffects<T>, M>['message']>;
      }) => MaybePromise<unknown | void>);
  dataType: 'form' | 'json';
  jsonChunkSize: number;
  validators:
    | false
    | Validators<UnwrapEffects<T>>
    | T
    | ZodEffects<T>
    | ZodEffects<ZodEffects<T>>
    | ZodEffects<ZodEffects<ZodEffects<T>>>
    | ZodEffects<ZodEffects<ZodEffects<ZodEffects<T>>>>
    | ZodEffects<ZodEffects<ZodEffects<ZodEffects<ZodEffects<T>>>>>;
  validationMethod: 'auto' | 'oninput' | 'onblur' | 'submit-only';
  defaultValidator: 'keep' | 'clear';
  clearOnSubmit: 'errors' | 'message' | 'errors-and-message' | 'none';
  delayMs: number;
  timeoutMs: number;
  multipleSubmits: 'prevent' | 'allow' | 'abort';
  syncFlashMessage?: boolean;
  flashMessage: {
    module: {
      getFlash(page: Readable<Page>): Writable<App.PageData['flash']>;
      updateFlash(
        page: Readable<Page>,
        update?: () => Promise<void>
      ): Promise<void>;
    };
    onError?: (event: {
      result: {
        type: 'error';
        status?: number;
        error: App.Error;
      };
      message: Writable<App.PageData['flash']>;
    }) => MaybePromise<unknown | void>;
    cookiePath?: string;
    cookieName?: string;
  };
}>;

const defaultFormOptions = {
  applyAction: true,
  invalidateAll: true,
  resetForm: false,
  autoFocusOnError: 'detect',
  scrollToError: 'smooth',
  errorSelector: '[data-invalid]',
  selectErrorText: false,
  stickyNavbar: undefined,
  taintedMessage:
    'Do you want to leave this page? Changes you made may not be saved.',
  onSubmit: undefined,
  onResult: undefined,
  onUpdate: undefined,
  onUpdated: undefined,
  onError: (event: { result: { error: unknown } }) => {
    console.warn(
      'Unhandled Superform error, use onError event to handle it:',
      event.result.error
    );
  },
  dataType: 'form',
  validators: undefined,
  defaultValidator: 'keep',
  clearOnSubmit: 'errors-and-message',
  delayMs: 500,
  timeoutMs: 8000,
  multipleSubmits: 'prevent',
  validation: undefined,
  SPA: undefined,
  validateMethod: 'auto'
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SuperFormSnapshot<T extends AnyZodObject, M = any> = Validation<
  T,
  M
> & { tainted: TaintedFields<T> | undefined };

type SuperFormEvents<T extends AnyZodObject, M> = Pick<
  FormOptions<T, M>,
  'onError' | 'onResult' | 'onSubmit' | 'onUpdate' | 'onUpdated'
>;

type SuperFormEventList<T extends AnyZodObject, M> = {
  [Property in keyof SuperFormEvents<T, M>]-?: NonNullable<
    SuperFormEvents<T, M>[Property]
  >[];
};

type TaintOption = boolean | 'untaint' | 'untaint-all';

type ValidateOptions<V> = Partial<{
  value: V;
  update: boolean | 'errors' | 'value';
  taint: TaintOption;
  errors: string | string[];
}>;

type Validate<
  T extends AnyZodObject,
  P extends FieldPath<z.infer<T>>, // = FieldPath<z.infer<T>>,
  Path extends keyof z.infer<T> | P // = keyof z.infer<T> | P
> = (
  path: Path,
  opts?: ValidateOptions<unknown>
) => Promise<string[] | undefined>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SuperForm<T extends ZodValidation<AnyZodObject>, M = any> = {
  form: {
    subscribe: Readable<z.infer<T>>['subscribe'];
    set(
      this: void,
      value: z.infer<T>,
      options?: { taint?: TaintOption }
    ): void;
    update(
      this: void,
      updater: Updater<z.infer<T>>,
      options?: { taint?: TaintOption }
    ): void;
  };
  formId: Writable<string | undefined>;
  errors: Writable<Validation<T, M>['errors']>;
  constraints: Writable<Validation<T, M>['constraints']>;
  message: Writable<Validation<T, M>['message']>;
  tainted: Writable<TaintedFields<UnwrapEffects<T>> | undefined>;
  meta: Readable<Validation<T, M>['meta']>;

  valid: Readable<boolean>;
  empty: Readable<boolean>;
  submitting: Readable<boolean>;
  delayed: Readable<boolean>;
  timeout: Readable<boolean>;

  fields: FormFields<UnwrapEffects<T>>;
  firstError: Readable<{ path: string[]; message: string } | null>;
  allErrors: Readable<{ path: string[]; message: string }[]>;

  options: FormOptions<T, M>;

  enhance: (
    el: HTMLFormElement,
    events?: SuperFormEvents<UnwrapEffects<T>, M>
  ) => ReturnType<typeof formEnhance>;

  reset: (options?: { keepMessage: boolean }) => void;

  capture: () => SuperFormSnapshot<UnwrapEffects<T>, M>;
  restore: (snapshot: SuperFormSnapshot<UnwrapEffects<T>, M>) => void;

  validate: Validate<
    UnwrapEffects<T>,
    FieldPath<z.infer<UnwrapEffects<T>>>,
    keyof z.infer<UnwrapEffects<T>> | FieldPath<z.infer<UnwrapEffects<T>>>
  >;
};

/**
 * @deprecated Use SuperForm instead.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EnhancedForm<T extends AnyZodObject, M = any> = SuperForm<T, M>;

/**
 * Initializes a SvelteKit form, for convenient handling of values, errors and sumbitting data.
 * @param {Validation} form Usually data.form from PageData.
 * @param {FormOptions} options Configuration for the form.
 * @returns {SuperForm} An object with properties for the form.
 */
export function superForm<
  T extends ZodValidation<AnyZodObject> = ZodValidation<AnyZodObject>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  M = any
>(
  form:
    | z.infer<UnwrapEffects<T>>
    | Validation<UnwrapEffects<T>, M>
    | null
    | undefined
    | string,
  options: FormOptions<UnwrapEffects<T>, M> = {}
): SuperForm<UnwrapEffects<T>, M> {
  type T2 = UnwrapEffects<T>;

  options = { ...(defaultFormOptions as FormOptions<T2, M>), ...options };

  function emptyForm(data: Partial<z.infer<T>> = {}): Validation<T2, M> {
    return {
      valid: false,
      errors: {},
      data,
      empty: true,
      constraints: {} as Validation<T2, M>['constraints']
    };
  }

  function findForms(data: Record<string, unknown>) {
    return Object.values(data).filter(
      (v) => isValidationObject(v) !== false
    ) as Validation<AnyZodObject>[];
  }

  /**
   * Return false if object isn't a validation object, otherwise the form id,
   * which may be undefined, so a falsy check isn't enough.
   */
  function isValidationObject(object: unknown): string | undefined | false {
    if (!object || typeof object !== 'object') return false;

    if (
      !(
        'valid' in object &&
        'empty' in object &&
        typeof object.valid === 'boolean'
      )
    ) {
      return false;
    }

    return 'id' in object && typeof object.id === 'string'
      ? object.id
      : undefined;
  }

  if (typeof form === 'string' && typeof options.id === 'string') {
    throw new SuperFormError(
      'You cannot specify an id both in the first superForm argument and in the options.'
    );
  }

  const unsubscriptions: (() => void)[] = [];

  onDestroy(() => {
    unsubscriptions.forEach((unsub) => unsub());

    for (const events of Object.values(formEvents)) {
      events.length = 0;
    }
  });

  let formId = typeof form === 'string' ? form : options.id ?? form?.id;
  const FormId = writable<string | undefined>(formId);
  unsubscriptions.push(FormId.subscribe((id) => (formId = id)));

  // Detect if a form is posted without JavaScript.
  {
    const postedForm = get(page).form;
    if (postedForm && typeof postedForm === 'object') {
      for (const superForm of findForms(postedForm).reverse()) {
        if (superForm.id === formId) {
          form = superForm as Validation<T2, M>;
          break;
        }
      }
    }
  }

  // Check for nested objects, throw if datatype isn't json
  function checkJson(key: string, value: unknown) {
    if (!value || typeof value !== 'object') return;

    if (Array.isArray(value)) {
      if (value.length > 0) checkJson(key, value[0]);
    } else if (!(value instanceof Date)) {
      throw new SuperFormError(
        `Object found in form field "${key}". Set options.dataType = 'json' and use:enhance to use nested data structures.`
      );
    }
  }

  // Normalize form argument to Validation<T, M>
  if (!form || typeof form === 'string') {
    form = emptyForm(); // Takes care of null | undefined | string
  } else if (isValidationObject(form) === false) {
    form = emptyForm(form); // Takes care of Partial<z.infer<T>>
  }

  const form2 = form as Validation<T2, M>;

  if (options.dataType !== 'json') {
    for (const [key, value] of Object.entries(form2.data)) {
      checkJson(key, value);
    }
  }

  // Need to clone the validation data, in case
  // it's used to populate multiple forms.
  const initialForm = clone(form2);
  const storeForm = clone(form2);

  // Stores for the properties of Validation<T, M>
  const Valid = writable(storeForm.valid);
  const Empty = writable(storeForm.empty);
  const Message = writable<M | undefined>(storeForm.message);
  const Errors = writable(storeForm.errors);
  const Constraints = writable(storeForm.constraints);
  const Meta = writable<Validation<T2, M>['meta'] | undefined>(
    storeForm.meta
  );

  let taintedFormState: typeof initialForm.data = clone(initialForm.data);

  const _formData = writable(storeForm.data);
  const Form = {
    subscribe: _formData.subscribe,
    set: (
      value: Parameters<typeof _formData.set>[0],
      options: { taint?: TaintOption } = {}
    ) => {
      checkTainted(value, taintedFormState, options.taint ?? true);
      taintedFormState = clone(value);
      return _formData.set(value);
    },
    update: (
      updater: Parameters<typeof _formData.update>[0],
      options: { taint?: TaintOption } = {}
    ) => {
      return _formData.update((value) => {
        const output = updater(value);
        checkTainted(output, taintedFormState, options.taint ?? true);
        taintedFormState = clone(value);
        return output;
      });
    }
  };

  const LastChanges = writable<string[][]>([]);

  function checkTainted(
    newObj: unknown,
    compareAgainst: unknown,
    options: TaintOption
  ) {
    if (options === false) {
      return;
    } else if (options === 'untaint-all') {
      Tainted.set(undefined);
      return;
    }

    const paths = comparePaths(newObj, compareAgainst);

    if (options === true) {
      LastChanges.set(paths);
    }

    if (paths.length) {
      Tainted.update((tainted) => {
        //console.log('Update tainted:', paths, newObj, compareAgainst);
        if (!tainted) tainted = {};
        setPaths(tainted, paths, options === true ? true : undefined);
        return tainted;
      });
    }
  }

  const Tainted = writable<TaintedFields<T2> | undefined>();

  // Timers
  const Submitting = writable(false);
  const Delayed = writable(false);
  const Timeout = writable(false);

  // Utilities
  const AllErrors = derived(Errors, ($errors) => {
    if (!$errors) return [];
    return findErrors($errors);
  });

  const FirstError = derived(AllErrors, ($all) => $all[0] ?? null);

  //////////////////////////////////////////////////////////////////////

  if (typeof initialForm.valid !== 'boolean') {
    throw new SuperFormError(
      'A non-validation object was passed to superForm. ' +
        "Check what's passed to its first parameter (null/undefined is allowed)."
    );
  }

  if (options.SPA && options.validators === undefined) {
    console.warn(
      'No validators set for Superform in SPA mode. Add them to the validators option, or set it to false to disable this warning.'
    );
  }

  // Need to set this after use:enhance has run, to avoid showing the
  // tainted dialog when a form doesn't use it or the browser doesn't use JS.
  const _taintedMessage = options.taintedMessage;
  options.taintedMessage = undefined;

  function enableTaintedMessage() {
    options.taintedMessage = _taintedMessage;
  }

  function rebind(
    form: Validation<T2, M>,
    untaint: TaintedFields<T2> | boolean,
    message?: M
  ) {
    if (untaint) {
      Tainted.set(typeof untaint === 'boolean' ? undefined : untaint);
      taintedFormState = clone(form.data);
    }

    message = message ?? form.message;

    Form.set(form.data);
    Message.set(message);
    Empty.set(form.empty);
    Valid.set(form.valid);
    Errors.set(form.errors);
    Meta.set(form.meta);
    FormId.set(form.id);

    if (options.flashMessage && shouldSyncFlash(options)) {
      const flash = options.flashMessage.module.getFlash(page);
      if (message && get(flash) === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        flash.set(message as any);
      }
    }
  }

  async function _update(form: Validation<T2, M>, untaint: boolean) {
    let cancelled = false;
    const data = {
      form,
      cancel: () => (cancelled = true)
    };

    for (const event of formEvents.onUpdate) {
      await event(data);
    }

    if (cancelled) {
      if (options.flashMessage) cancelFlash(options);
      return;
    }

    if (
      form.valid &&
      options.resetForm &&
      (options.resetForm === true || (await options.resetForm()))
    ) {
      _resetForm(form.message);
    } else {
      rebind(form, untaint);
    }

    // onUpdated may check stores, so need to wait for them to update.
    if (formEvents.onUpdated.length) {
      await tick();
    }

    // But do not await on onUpdated itself, since we're already finished with the request
    for (const event of formEvents.onUpdated) {
      event({ form });
    }
  }

  function _resetForm(message?: M) {
    rebind(clone(initialForm), true, message);
  }

  const Form_update: FormUpdate = async (result, untaint?: boolean) => {
    if (result.type == ('error' as string)) {
      throw new SuperFormError(
        `ActionResult of type "${result.type}" cannot be passed to update function.`
      );
    }

    // All we need to do if redirected is to reset the form.
    // No events should be triggered because technically we're somewhere else.
    if (result.type == 'redirect') {
      if (
        options.resetForm &&
        (options.resetForm === true || (await options.resetForm()))
      ) {
        _resetForm();
      }
      return;
    }

    if (typeof result.data !== 'object') {
      throw new SuperFormError(
        'Non-object validation data returned from ActionResult.'
      );
    }

    const forms = findForms(result.data);
    if (!forms.length) {
      throw new SuperFormError(
        'No form data returned from ActionResult. Make sure you return { form } in the form actions.'
      );
    }

    for (const newForm of forms) {
      if (newForm.id !== formId) continue;
      await _update(
        newForm as Validation<T2, M>,
        untaint ?? (result.status >= 200 && result.status < 300)
      );
    }
  };

  const formEvents: SuperFormEventList<T2, M> = {
    onSubmit: options.onSubmit ? [options.onSubmit] : [],
    onResult: options.onResult ? [options.onResult] : [],
    onUpdate: options.onUpdate ? [options.onUpdate] : [],
    onUpdated: options.onUpdated ? [options.onUpdated] : [],
    onError: options.onError ? [options.onError] : []
  };

  ///// When use:enhance is enabled ///////////////////////////////////////////

  function isTainted(obj: unknown): boolean {
    if (obj === null)
      throw new SuperFormError('$tainted store contained null');

    if (typeof obj === 'object') {
      for (const obj2 of Object.values(obj)) {
        if (isTainted(obj2)) return true;
      }
    }
    return obj === true;
  }

  if (browser) {
    beforeNavigate((nav) => {
      if (options.taintedMessage && !get(Submitting)) {
        const taintStatus = get(Tainted);
        if (
          taintStatus &&
          isTainted(taintStatus) &&
          !window.confirm(options.taintedMessage)
        ) {
          nav.cancel();
        }
      }
    });

    // Need to subscribe to catch page invalidation.
    if (options.applyAction) {
      unsubscriptions.push(
        page.subscribe(async (pageUpdate) => {
          function error(type: string) {
            throw new SuperFormError(
              `No form data found in ${type}. Make sure you return { form } in form actions and load functions.`
            );
          }

          const untaint =
            pageUpdate.status >= 200 && pageUpdate.status < 300;

          if (pageUpdate.form && typeof pageUpdate.form === 'object') {
            const forms = findForms(pageUpdate.form);
            if (!forms.length) error('$page.form (ActionData)');

            for (const newForm of forms) {
              //console.log('🚀~ ActionData ~ newForm:', newForm.id);
              if (newForm === form || newForm.id !== formId) continue;

              await _update(newForm as Validation<T2, M>, untaint);
            }
          } else if (
            pageUpdate.data &&
            typeof pageUpdate.data === 'object'
          ) {
            const forms = findForms(pageUpdate.data);

            // It's a page reload, redirect or error/failure,
            // so don't trigger any events, just update the data.
            for (const newForm of forms) {
              //console.log('🚀 ~ PageData ~ newForm:', newForm.id);
              if (newForm === form || newForm.id !== formId) continue;

              rebind(newForm as Validation<T2, M>, untaint);
            }
          }
        })
      );
    }
  }

  const Fields = Object.fromEntries(
    Object.keys(initialForm.data).map((key) => {
      return [key, Fields_create(key, initialForm)];
    })
  ) as unknown as FormFields<T2>;

  function Fields_create(
    key: keyof z.infer<T>,
    validation: Validation<T2, M>
  ) {
    return {
      name: key,
      value: fieldProxy(Form, key),
      errors: fieldProxy(Errors, key),
      constraints: fieldProxy(Constraints, key),
      type: validation.meta?.types[key]
    };
  }

  return {
    form: Form,
    formId: FormId,
    errors: Errors,
    message: Message,
    constraints: Constraints,
    meta: derived(Meta, ($m) => $m),

    fields: Fields,

    tainted: Tainted,
    valid: derived(Valid, ($s) => $s),
    empty: derived(Empty, ($e) => $e),

    submitting: derived(Submitting, ($s) => $s),
    delayed: derived(Delayed, ($d) => $d),
    timeout: derived(Timeout, ($t) => $t),

    options,

    capture: function () {
      return {
        valid: get(Valid),
        errors: get(Errors),
        data: get(Form),
        empty: get(Empty),
        constraints: get(Constraints),
        message: get(Message),
        id: formId,
        meta: get(Meta),
        tainted: get(Tainted)
      };
    },

    restore: function (snapshot: SuperFormSnapshot<T2, M>) {
      return rebind(snapshot, snapshot.tainted ?? true);
    },

    validate: (path, opts) => {
      return validateField(
        (Array.isArray(path) ? path : [path]) as string[],
        options.validators,
        options.defaultValidator,
        Form,
        Errors,
        Tainted,
        opts
      );
    },
    enhance: (el: HTMLFormElement, events?: SuperFormEvents<T2, M>) => {
      if (events) {
        if (events.onError) {
          if (options.onError === 'apply') {
            throw new SuperFormError(
              'options.onError is set to "apply", cannot add any onError events.'
            );
          } else if (events.onError === 'apply') {
            throw new SuperFormError(
              'Cannot add "apply" as onError event in use:enhance.'
            );
          }

          formEvents.onError.push(events.onError);
        }
        if (events.onResult) formEvents.onResult.push(events.onResult);
        if (events.onSubmit) formEvents.onSubmit.push(events.onSubmit);
        if (events.onUpdate) formEvents.onUpdate.push(events.onUpdate);
        if (events.onUpdated) formEvents.onUpdated.push(events.onUpdated);
      }

      return formEnhance(
        el,
        Submitting,
        Delayed,
        Timeout,
        Errors,
        Form_update,
        options,
        Form,
        Message,
        enableTaintedMessage,
        formEvents,
        FormId,
        Meta,
        Constraints,
        Tainted,
        LastChanges
      );
    },

    firstError: FirstError,
    allErrors: AllErrors,
    reset: (options?) =>
      _resetForm(options?.keepMessage ? get(Message) : undefined)
  };
}

function cancelFlash<T extends AnyZodObject, M>(options: FormOptions<T, M>) {
  if (!options.flashMessage || !browser) return;
  if (!shouldSyncFlash(options)) return;

  document.cookie = `flash=; Max-Age=0; Path=${
    options.flashMessage.cookiePath ?? '/'
  };`;
}

function shouldSyncFlash<T extends AnyZodObject, M>(
  options: FormOptions<T, M>
) {
  if (!options.flashMessage || !browser) return false;
  return options.syncFlashMessage;
}

function isPathTainted(
  path: string[],
  tainted: TaintedFields<AnyZodObject> | undefined
) {
  if (tainted === undefined) return false;
  const leaf = traversePath(tainted, path as FieldPath<typeof tainted>);
  if (!leaf) return false;
  return leaf.value === true;
}

/**
 * To work with client-side validation, errors cannot be deleted but must
 * be set to undefined, to know where they existed before (tainted+error check in oninput)
 */
function errors_clear(
  errors: Writable<ValidationErrors<AnyZodObject>>,
  undefinePath: string[] = []
) {
  errors.update(($errors) => {
    traversePaths($errors, (pathData) => {
      if (Array.isArray(pathData.value)) {
        return pathData.set(undefined);
      }
    });
    if (undefinePath) setPaths($errors, [undefinePath], undefined);
    return $errors;
  });
}

const effectMapCache = new WeakMap<object, boolean>();

async function validateField<T extends AnyZodObject, M>(
  path: string[],
  validators: FormOptions<T, M>['validators'],
  defaultValidator: FormOptions<T, M>['defaultValidator'],
  data: SuperForm<T, M>['form'],
  errors: SuperForm<T, M>['errors'],
  tainted: SuperForm<T, M>['tainted'],
  options: ValidateOptions<unknown> = {}
): Promise<string[] | undefined> {
  if (options.update === undefined) options.update = true;
  if (options.taint === undefined) options.taint = false;

  function setError(errorMsgs: null | undefined | string | string[]) {
    if (typeof errorMsgs === 'string') errorMsgs = [errorMsgs];

    if (options.update === true || options.update == 'errors') {
      errors.update((errors) => {
        const error = traversePath(
          errors,
          path as FieldPath<typeof errors>,
          (node) => {
            if (node.value === undefined) {
              node.parent[node.key] = {};
              return node.parent[node.key];
            } else {
              return node.value;
            }
          }
        );

        if (!error)
          throw new SuperFormError(
            'Error path could not be created: ' + path
          );

        error.parent[error.key] = errorMsgs ?? undefined;
        return errors;
      });
    }
    return errorMsgs ?? undefined;
  }

  async function defaultValidate() {
    if (defaultValidator == 'clear') {
      setError(undefined);
    }
    return undefined;
  }

  let value = options.value;
  let shouldUpdate = true;
  let currentData: z.infer<T> | undefined = undefined;

  if (!('value' in options)) {
    // Use value from data
    currentData = get(data);

    const dataToValidate = traversePath(
      currentData,
      path as FieldPath<typeof currentData>
    );

    value = dataToValidate?.value;
  } else if (options.update === true || options.update === 'value') {
    // Value should be updating the data
    data.update(
      ($data) => {
        setPaths($data, [path], value);
        return (currentData = $data);
      },
      { taint: options.taint }
    );
  } else {
    shouldUpdate = false;
  }

  //console.log('🚀 ~ file: index.ts:871 ~ validate:', path, value);

  if (typeof validators !== 'object') {
    return defaultValidate();
  }

  // Remove numeric indices, they're not used for validators.
  const validationPath = path.filter((p) => isNaN(parseInt(p)));

  function extractValidator(
    data: ZodTypeInfo,
    key: string
  ): ZodTypeAny | undefined {
    if (data.effects) return undefined;

    // No effects, check if ZodObject or ZodArray, which are the
    // "allowed" objects in the path above the leaf.
    const type = data.zodType;

    if (type._def.typeName == 'ZodObject') {
      const nextType = (type as AnyZodObject)._def.shape()[key];
      const unwrapped = unwrapZodType(nextType);
      return unwrapped.effects ? undefined : unwrapped.zodType;
    } else if (type._def.typeName == 'ZodArray') {
      const array = type as ZodArray<ZodTypeAny>;
      const unwrapped = unwrapZodType(array.element);
      if (unwrapped.effects) return undefined;
      return extractValidator(unwrapped, key);
    } else {
      throw new SuperFormError('Invalid validator');
    }
  }

  if ('safeParseAsync' in validators) {
    // Zod validator
    // Check if any effects exist for the path, then parse the entire schema.
    if (!effectMapCache.has(validators)) {
      effectMapCache.set(validators, hasEffects(validators as ZodTypeAny));
    }

    const effects = effectMapCache.get(validators);

    const perFieldValidator = effects
      ? undefined
      : traversePath(
          validators,
          validationPath as FieldPath<typeof validators>,
          (pathData) => {
            return extractValidator(
              unwrapZodType(pathData.parent),
              pathData.key
            );
          }
        );

    if (perFieldValidator) {
      const validator = extractValidator(
        unwrapZodType(perFieldValidator.parent),
        perFieldValidator.key
      );
      if (validator) {
        //console.log('🚀 ~ file: index.ts:972 ~ no effects:', validator);
        const result = await validator.safeParseAsync(value);
        if (!result.success) {
          const errors = result.error.format();
          return setError(errors._errors);
        } else {
          return setError(undefined);
        }
      }
    }

    //console.log('🚀 ~ file: index.ts:983 ~ Effects found, validating all');

    // Effects are found, validate entire data, unfortunately
    if (!shouldUpdate) {
      // If value shouldn't update, clone and set the new value
      currentData = clone(currentData ?? get(data));
      setPaths(currentData, [path], value);
    }

    const result = await (validators as ZodTypeAny).safeParseAsync(
      currentData
    );

    if (!result.success) {
      const newErrors = mapErrors(result.error.format());

      if (options.update === true || options.update == 'errors') {
        //console.log('🚀 ~ file: index.ts:1020 ~ newErrors:', newErrors);

        // Set errors for other (tainted) fields, that may have been changed
        const taintedFields = get(tainted);
        const currentErrors = get(errors);
        let updated = false;

        traversePaths(newErrors, (pathData) => {
          if (!Array.isArray(pathData.value)) return;
          if (isPathTainted(pathData.path, taintedFields)) {
            setPaths(currentErrors, [pathData.path], pathData.value);
            updated = true;
          }
          return 'skip';
        });

        if (updated) errors.set(currentErrors);
      }

      // Finally, set errors for the specific field
      // it will be set to undefined if no errors, so the tainted+error check
      // in oninput can determine if errors should be displayed or not.
      const current = traversePath(
        newErrors,
        path as FieldPath<typeof newErrors>
      );

      return setError(options.errors ?? current?.value);
    } else {
      // We validated the whole data structure, so clear all errors on success
      // but also set the current path to undefined, so it will be used in the tainted+error
      // check in oninput.
      errors_clear(errors, path);
      return undefined;
    }
  } else {
    // SuperForms validator

    const validator = traversePath(
      validators as Validators<UnwrapEffects<T>>,
      validationPath as FieldPath<typeof validators>
    );

    if (!validator) {
      // Path didn't exist
      throw new SuperFormError('No Superforms validator found: ' + path);
    } else if (validator.value === undefined) {
      // No validator, use default
      return defaultValidate();
    } else {
      const result = validator.value(value);
      return setError(result ? options.errors ?? result : result);
    }
  }
}

/**
 * Custom use:enhance version. Flash message support, friendly error messages, for usage with initializeForm.
 * @param formEl Form element from the use:formEnhance default parameter.
 */
function formEnhance<T extends AnyZodObject, M>(
  formEl: HTMLFormElement,
  submitting: Writable<boolean>,
  delayed: Writable<boolean>,
  timeout: Writable<boolean>,
  errs: Writable<unknown>,
  Data_update: FormUpdate,
  options: FormOptions<T, M>,
  data: Writable<z.infer<T>>,
  message: Writable<M | undefined>,
  enableTaintedForm: () => void,
  formEvents: SuperFormEventList<T, M>,
  id: Readable<string | undefined>,
  meta: Readable<Entity<T>['meta'] | undefined>,
  constraints: Readable<Entity<T>['constraints']>,
  tainted: Writable<TaintedFields<T> | undefined>,
  lastChanges: Writable<string[][]>
) {
  // Now we know that we are upgraded, so we can enable the tainted form option.
  enableTaintedForm();

  // Using this type in the function argument causes a type recursion error.
  const errors = errs as Writable<ValidationErrors<T>>;

  function equal(one: string[][], other: string[][]) {
    return (
      one.map((v) => v.join()).join() == other.map((v) => v.join()).join()
    );
  }

  function validateChange(change: string[]) {
    validateField(
      change,
      options.validators,
      options.defaultValidator,
      data,
      errors,
      tainted
    );
  }

  // Add blur event, to check tainted
  async function checkBlur(e: Event) {
    if (
      options.validationMethod == 'oninput' ||
      options.validationMethod == 'submit-only'
    ) {
      return;
    }

    // Select bindings have some timing issue, need to wait
    if (e.target instanceof HTMLSelectElement) {
      await new Promise((r) => setTimeout(r, 0));
    }

    for (const change of get(lastChanges)) {
      //console.log('🚀 ~ file: index.ts:905 ~ BLUR:', change);
      validateChange(change);
    }
    // Clear last changes after blur (not after input)
    lastChanges.set([]);
  }
  formEl.addEventListener('focusout', checkBlur);

  // Add input event, to check tainted
  async function checkInput(e: Event) {
    if (
      options.validationMethod == 'onblur' ||
      options.validationMethod == 'submit-only'
    ) {
      return;
    }

    // Select bindings have some timing issue, need to wait
    if (e.target instanceof HTMLSelectElement) {
      await new Promise((r) => setTimeout(r, 0));
    }

    const errorContent = get(errors);
    const taintedContent = get(tainted);

    for (const change of get(lastChanges)) {
      let shouldValidate = options.validationMethod === 'oninput';

      if (!shouldValidate) {
        const isTainted =
          taintedContent &&
          pathExists(taintedContent, change, (value) => value === true);

        const errorNode = errorContent
          ? pathExists(errorContent, change)
          : undefined;

        // Need a special check here, since if the error has never existed,
        // there won't be a key for the error. But if it existed and was cleared,
        // the key exists with the value undefined.
        const hasError = errorNode && errorNode.key in errorNode.parent;

        shouldValidate = !!isTainted && !!hasError;
      }

      if (shouldValidate) {
        //console.log('🚀 ~ file: index.ts:920 ~ INPUT with error:', change);
        validateChange(change);
      }
    }
  }
  formEl.addEventListener('input', checkInput);

  const ErrorTextEvents = new Set<HTMLFormElement>();

  function ErrorTextEvents_selectText(e: Event) {
    const target = e.target as HTMLInputElement;
    if (options.selectErrorText) target.select();
  }

  function ErrorTextEvents_addErrorTextListeners(formEl: HTMLFormElement) {
    formEl.querySelectorAll('input').forEach((el) => {
      el.addEventListener('invalid', ErrorTextEvents_selectText);
    });
  }

  function ErrorTextEvents_removeErrorTextListeners(
    formEl: HTMLFormElement
  ) {
    formEl
      .querySelectorAll('input')
      .forEach((el) =>
        el.removeEventListener('invalid', ErrorTextEvents_selectText)
      );
  }

  onDestroy(() => {
    ErrorTextEvents.forEach((formEl) =>
      ErrorTextEvents_removeErrorTextListeners(formEl)
    );
    ErrorTextEvents.clear();
    formEl.removeEventListener('focusout', checkBlur);
    formEl.removeEventListener('input', checkInput);
  });

  type ValidationResponse<
    Success extends Record<string, unknown> | undefined = Record<
      string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      any
    >,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Invalid extends Record<string, unknown> | undefined = Record<string, any>
  > = { result: ActionResult<Success, Invalid> };

  /**
   * @DCI-context
   */
  function Form(formEl: HTMLFormElement) {
    function rebind() {
      if (options.selectErrorText) {
        if (Form && formEl !== Form) {
          ErrorTextEvents_removeErrorTextListeners(Form as HTMLFormElement);
          ErrorTextEvents.delete(Form as HTMLFormElement);
        }
        if (!ErrorTextEvents.has(formEl)) {
          ErrorTextEvents_addErrorTextListeners(formEl);
          ErrorTextEvents.add(formEl);
        }
      }

      Form = formEl;
    }

    let Form: {
      querySelectorAll: (selector: string) => NodeListOf<HTMLElement>;
      querySelector: (selector: string) => HTMLElement;
      dataset: DOMStringMap;
    };

    function Form_shouldAutoFocus(userAgent: string) {
      if (typeof options.autoFocusOnError === 'boolean')
        return options.autoFocusOnError;
      else return !/iPhone|iPad|iPod|Android/i.test(userAgent);
    }

    const Form_scrollToFirstError = async () => {
      if (options.scrollToError == 'off') return;

      const selector = options.errorSelector;
      if (!selector) return;

      // Wait for form to update with errors
      await tick();

      // Scroll to first form message, if not visible
      let el: HTMLElement | null;
      el = Form.querySelector(selector) as HTMLElement | null;
      if (!el) return;
      // Find underlying element if it is a FormGroup element
      el = el.querySelector(selector) ?? el;

      const nav = options.stickyNavbar
        ? (document.querySelector(options.stickyNavbar) as HTMLElement)
        : null;

      if (!isElementInViewport(el, nav?.offsetHeight ?? 0)) {
        scrollToAndCenter(el, undefined, options.scrollToError);
      }

      // Don't focus on the element if on mobile, it will open the keyboard
      // and probably hide the error message.
      if (!Form_shouldAutoFocus(navigator.userAgent)) return;

      let focusEl;
      focusEl = el;

      if (
        !['INPUT', 'SELECT', 'BUTTON', 'TEXTAREA'].includes(focusEl.tagName)
      ) {
        focusEl = focusEl.querySelector<HTMLElement>(
          'input:not([type="hidden"]):not(.flatpickr-input), select, textarea'
        );
      }

      if (focusEl) {
        try {
          focusEl.focus({ preventScroll: true });
          if (options.selectErrorText && focusEl.tagName == 'INPUT') {
            (focusEl as HTMLInputElement).select();
          }
        } catch (err) {
          // Some hidden inputs like from flatpickr cannot be focused.
        }
      }
    };

    rebind();

    {
      let state: FetchStatus = FetchStatus.Idle;
      let delayedTimeout: number, timeoutTimeout: number;

      const setState = (s: typeof state) => {
        state = s;
        submitting.set(state >= FetchStatus.Submitting);
        delayed.set(state >= FetchStatus.Delayed);
        timeout.set(state >= FetchStatus.Timeout);
      };

      return {
        submitting: () => {
          rebind();
          setState(
            state != FetchStatus.Delayed
              ? FetchStatus.Submitting
              : FetchStatus.Delayed
          );

          // https://www.nngroup.com/articles/response-times-3-important-limits/
          if (delayedTimeout) clearTimeout(delayedTimeout);
          if (timeoutTimeout) clearTimeout(timeoutTimeout);

          delayedTimeout = window.setTimeout(() => {
            if (state == FetchStatus.Submitting)
              setState(FetchStatus.Delayed);
          }, options.delayMs);

          timeoutTimeout = window.setTimeout(() => {
            if (state == FetchStatus.Delayed) setState(FetchStatus.Timeout);
          }, options.timeoutMs);
        },

        completed: (cancelled: boolean) => {
          if (delayedTimeout) clearTimeout(delayedTimeout);
          if (timeoutTimeout) clearTimeout(timeoutTimeout);
          delayedTimeout = timeoutTimeout = 0;

          setState(FetchStatus.Idle);
          if (!cancelled) setTimeout(Form_scrollToFirstError);
        },

        scrollToFirstError: () => setTimeout(Form_scrollToFirstError),

        isSubmitting: () =>
          state === FetchStatus.Submitting || state === FetchStatus.Delayed
      };
    }
  }

  const htmlForm = Form(formEl);
  let currentRequest: AbortController | null;

  return enhance(formEl, async (submit) => {
    let cancelled = false;
    function cancel() {
      cancelled = true;
      return submit.cancel();
    }

    if (htmlForm.isSubmitting() && options.multipleSubmits == 'prevent') {
      cancel();
    } else {
      if (htmlForm.isSubmitting() && options.multipleSubmits == 'abort') {
        if (currentRequest) currentRequest.abort();
      }
      currentRequest = submit.controller;

      const data = { ...submit, cancel };

      for (const event of formEvents.onSubmit) {
        await event(data);
      }
    }

    if (cancelled) {
      if (options.flashMessage) cancelFlash(options);
    } else {
      // Client validation
      if (options.validators) {
        const checkData = get(data);
        let valid: boolean;
        let clientErrors: ValidationErrors<T> = {};

        if ('safeParseAsync' in options.validators) {
          // Zod validator
          const validator = options.validators as AnyZodObject;
          const result = await validator.safeParseAsync(checkData);

          valid = result.success;

          if (!result.success) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            clientErrors = mapErrors<T>(result.error.format()) as any;
          }
        } else {
          // SuperForms validator

          valid = true;

          const validator = options.validators as Validators<T>;
          const newErrors: {
            path: string[];
            errors: string[] | undefined;
          }[] = [];

          await traversePathsAsync(checkData, async ({ value, path }) => {
            // Filter out array indices, the validator structure doesn't contain these.
            const validationPath = path.filter((p) => isNaN(parseInt(p)));
            const maybeValidator = traversePath(
              validator,
              validationPath as FieldPath<typeof validator>
            );

            if (typeof maybeValidator?.value === 'function') {
              const check = maybeValidator.value as Validator<unknown>;

              if (Array.isArray(value)) {
                for (const key in value) {
                  const errors = await check(value[key]);
                  if (errors) {
                    valid = false;
                    newErrors.push({
                      path: path.concat([key]),
                      errors:
                        typeof errors === 'string'
                          ? [errors]
                          : errors ?? undefined
                    });
                  }
                }
              } else {
                const errors = await check(value);
                if (errors) {
                  valid = false;
                  newErrors.push({
                    path,
                    errors:
                      typeof errors === 'string'
                        ? [errors]
                        : errors ?? undefined
                  });
                }
              }
            }
          });

          for (const { path, errors } of newErrors) {
            const errorPath = traversePath(
              clientErrors,
              path as FieldPath<typeof clientErrors>,
              ({ parent, key, value }) => {
                if (value === undefined) parent[key] = {};
                return parent[key];
              }
            );

            if (errorPath) {
              const { parent, key } = errorPath;
              parent[key] = errors;
            }
          }
        }

        if (!valid) {
          cancel();

          const validationResult: Validation<T> = {
            valid,
            errors: clientErrors,
            data: checkData,
            empty: false,
            constraints: get(constraints),
            message: undefined,
            id: get(id),
            meta: get(meta)
          };

          const result = {
            type: 'failure' as const,
            status:
              (typeof options.SPA === 'boolean'
                ? undefined
                : options.SPA?.failStatus) ?? 400,
            data: { form: validationResult }
          };

          setTimeout(() => validationResponse({ result }), 0);
        }
      }

      if (!cancelled) {
        switch (options.clearOnSubmit) {
          case 'errors-and-message':
            errors_clear(errors);
            message.set(undefined);
            break;

          case 'errors':
            errors_clear(errors);
            break;

          case 'message':
            message.set(undefined);
            break;
        }

        if (
          options.flashMessage &&
          (options.clearOnSubmit == 'errors-and-message' ||
            options.clearOnSubmit == 'message') &&
          shouldSyncFlash(options)
        ) {
          options.flashMessage.module.getFlash(page).set(undefined);
        }

        htmlForm.submitting();

        if (options.SPA) {
          cancel();

          const validationResult: Validation<T> = {
            valid: true,
            errors: {},
            data: get(data),
            empty: false,
            constraints: get(constraints),
            message: undefined,
            id: get(id),
            meta: get(meta)
          };

          const result = {
            type: 'success' as const,
            status: 200,
            data: { form: validationResult }
          };

          setTimeout(() => validationResponse({ result }), 0);
        } else if (options.dataType === 'json') {
          const postData = get(data);
          const chunks = chunkSubstr(
            stringify(postData),
            options.jsonChunkSize ?? 500000
          );

          for (const chunk of chunks) {
            submit.data.append('__superform_json', chunk);
          }

          // Clear post data to reduce transfer size,
          // since $form should be serialized and sent as json.
          Object.keys(postData).forEach((key) => {
            // Files should be kept though, even if same key.
            if (typeof submit.data.get(key) === 'string') {
              submit.data.delete(key);
            }
          });
        }
      }
    }

    // Thanks to https://stackoverflow.com/a/29202760/70894
    function chunkSubstr(str: string, size: number) {
      const numChunks = Math.ceil(str.length / size);
      const chunks = new Array(numChunks);

      for (let i = 0, o = 0; i < numChunks; ++i, o += size) {
        chunks[i] = str.substring(o, o + size);
      }

      return chunks;
    }

    async function validationResponse(event: ValidationResponse) {
      const result = event.result;

      currentRequest = null;
      let cancelled = false;

      const data = {
        result,
        formEl,
        cancel: () => (cancelled = true)
      };

      for (const event of formEvents.onResult) {
        await event(data);
      }

      if (!cancelled) {
        if (result.type !== 'error') {
          if (result.type === 'success' && options.invalidateAll) {
            await invalidateAll();
          }

          if (options.applyAction) {
            // This will trigger the page subscription in superForm,
            // which will in turn call Data_update.
            await applyAction(result);
          } else {
            // Call Data_update directly to trigger events
            await Data_update(result);
          }
        } else {
          // Error result
          if (options.applyAction) {
            if (options.onError == 'apply') {
              await applyAction(result);
            } else {
              // Transform to failure, to avoid data loss
              await applyAction({
                type: 'failure',
                status: Math.floor(result.status || 500)
              });
            }
          }

          // Check if the error message should be replaced
          if (options.onError !== 'apply') {
            // TODO: Omit 'apply' and undefined from the type
            // They are already filtered out, but type shouldn't be any.
            const data = { result, message };

            for (const event of formEvents.onError) {
              if (event !== 'apply') await event(data);
            }
          }
        }

        // Set flash message, which should be set in all cases, even
        // if we have redirected (which is the point of the flash message!)
        if (options.flashMessage) {
          if (result.type == 'error' && options.flashMessage.onError) {
            await options.flashMessage.onError({
              result,
              message: options.flashMessage.module.getFlash(page)
            });
          } else if (result.type != 'error') {
            await options.flashMessage.module.updateFlash(page);
          }
        }
      } else {
        // Cancelled
        if (options.flashMessage) cancelFlash(options);
      }

      htmlForm.completed(cancelled);
    }

    return validationResponse;
  });
}
