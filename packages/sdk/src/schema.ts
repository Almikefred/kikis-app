/**
 * Canonical KikisApp manifest JSON Schema (draft-07).
 *
 * Single source of truth for the manifest contract. Provider apps must import
 * this via the `@kikis-app/kikis-app/schema` subpath export rather than keeping
 * their own copy, so a field addition only has to be made in one place.
 *
 * @example
 * ```ts
 * import Ajv from 'ajv'
 * import schema from '@kikis-app/kikis-app/schema'
 *
 * const validate = new Ajv().compile(schema)
 * ```
 */
import kikisAppSchema from './schemas/kikis-app.schema.json'

export const schema: Record<string, unknown> = kikisAppSchema

export default schema
