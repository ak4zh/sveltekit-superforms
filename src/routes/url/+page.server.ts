import { superValidate } from '$lib/server';
import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { z } from 'zod';

const schema = z.object({
  id: z.number().int().positive().default(NaN)
});

///// Load //////////////////////////////////////////////////////////

export const load = (async ({ url }) => {
  const form = await superValidate(url, schema);
  console.log('load', form.data.id);
  return { form };
}) satisfies PageServerLoad;

///// Form actions //////////////////////////////////////////////////

export const actions = {
  default: async (event) => {
    const form = await superValidate(event, schema);
    console.log('post', form.data.id);
    return form.valid ? { form } : fail(400, { form });
  }
} satisfies Actions;
