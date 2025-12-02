/**
 * Entity Schema System for RBAC Management
 *
 * Defines declarative schemas for all RBAC entities (users, groups, roles, collections).
 * Schemas drive dynamic form generation and validation.
 */

/**
 * @typedef {'string' | 'email' | 'password' | 'multiselect' | 'textarea' | 'checkbox'} FieldType
 */

/**
 * Field definition for an entity
 * @typedef {object} EntityField
 * @property {string} name - Field name (maps to entity property)
 * @property {FieldType} type - Field input type
 * @property {string} label - Human-readable label
 * @property {boolean} [required] - Whether field is required
 * @property {boolean} [immutable] - Whether field cannot be edited after creation
 * @property {string} [options] - Name of entity type for select options (e.g., 'roles', 'groups')
 * @property {string} [placeholder] - Placeholder text
 * @property {string} [helpText] - Additional help text
 * @property {Function} [validator] - Custom validation function
 * @property {boolean} [hidden] - Whether field should be hidden
 */

/**
 * Relationship definition between entities
 * @typedef {object} EntityRelationship
 * @property {string} target - Target entity type (e.g., 'groups', 'roles')
 * @property {string} field - Field name containing the relationship
 * @property {'one-to-many' | 'many-to-many' | 'many-to-one'} type - Relationship type
 * @property {boolean} [cascadeDelete] - Whether deleting this entity should delete related entities
 */

/**
 * Complete entity schema definition
 * @typedef {object} EntitySchema
 * @property {string} label - Human-readable plural label
 * @property {string} singularLabel - Human-readable singular label
 * @property {string} idField - Name of the field used as unique identifier
 * @property {EntityField[]} fields - Field definitions
 * @property {EntityRelationship[]} [relationships] - Relationship definitions
 * @property {string} [icon] - Icon name for UI display
 * @property {Function} [onCreate] - Hook called when creating new entity
 * @property {Function} [onUpdate] - Hook called when updating entity
 * @property {Function} [onDelete] - Hook called when deleting entity
 */

/**
 * Entity schemas registry
 * @type {Record<string, EntitySchema>}
 */
const entitySchemas = {
  user: {
    label: 'Users',
    singularLabel: 'User',
    idField: 'username',
    icon: 'person',
    fields: [
      {
        name: 'username',
        type: 'string',
        label: 'Username',
        required: true,
        immutable: true,
        placeholder: 'Enter username',
        helpText: 'Unique username for login'
      },
      {
        name: 'fullname',
        type: 'string',
        label: 'Full Name',
        placeholder: 'Enter full name'
      },
      {
        name: 'email',
        type: 'email',
        label: 'Email',
        placeholder: 'user@example.com'
      },
      {
        name: 'passwd_hash',
        type: 'password',
        label: 'Password',
        placeholder: 'Leave empty to keep current password',
        helpText: 'Password will be hashed before storage'
      },
      {
        name: 'roles',
        type: 'multiselect',
        label: 'Roles',
        options: 'role',
        helpText: 'User roles determine permissions'
      },
      {
        name: 'groups',
        type: 'multiselect',
        label: 'Groups',
        options: 'group',
        helpText: 'Groups determine collection access'
      },
      {
        name: 'session_id',
        type: 'string',
        label: 'Session ID',
        hidden: true
      }
    ],
    relationships: [
      {
        target: 'group',
        field: 'groups',
        type: 'many-to-many'
      },
      {
        target: 'role',
        field: 'roles',
        type: 'many-to-many'
      }
    ]
  },

  group: {
    label: 'Groups',
    singularLabel: 'Group',
    idField: 'id',
    icon: 'people',
    fields: [
      {
        name: 'id',
        type: 'string',
        label: 'ID',
        required: true,
        immutable: true,
        placeholder: 'group-id',
        helpText: 'Unique group identifier'
      },
      {
        name: 'name',
        type: 'string',
        label: 'Name',
        required: true,
        placeholder: 'Group Name'
      },
      {
        name: 'description',
        type: 'textarea',
        label: 'Description',
        placeholder: 'Describe the group purpose'
      },
      {
        name: 'collections',
        type: 'multiselect',
        label: 'Collections',
        options: 'collection',
        helpText: 'Collections accessible to this group (use "*" for all)'
      }
    ],
    relationships: [
      {
        target: 'collection',
        field: 'collections',
        type: 'many-to-many'
      }
    ]
  },

  role: {
    label: 'Roles',
    singularLabel: 'Role',
    idField: 'id',
    icon: 'shield',
    fields: [
      {
        name: 'id',
        type: 'string',
        label: 'ID',
        required: true,
        immutable: true,
        placeholder: 'role-id',
        helpText: 'Unique role identifier'
      },
      {
        name: 'roleName',
        type: 'string',
        label: 'Role Name',
        required: true,
        placeholder: 'Role Display Name'
      },
      {
        name: 'description',
        type: 'textarea',
        label: 'Description',
        placeholder: 'Describe the role permissions'
      }
    ],
    relationships: []
  },

  collection: {
    label: 'Collections',
    singularLabel: 'Collection',
    idField: 'id',
    icon: 'folder',
    fields: [
      {
        name: 'id',
        type: 'string',
        label: 'ID',
        required: true,
        immutable: true,
        placeholder: 'collection-id',
        helpText: 'Unique collection identifier'
      },
      {
        name: 'name',
        type: 'string',
        label: 'Name',
        required: true,
        placeholder: 'Collection Name'
      },
      {
        name: 'description',
        type: 'textarea',
        label: 'Description',
        placeholder: 'Describe the collection contents'
      }
    ],
    relationships: []
  }
}

/**
 * Get schema for an entity type
 * @param {string} entityType - Entity type key (user, group, role, collection)
 * @returns {EntitySchema | null} Entity schema or null if not found
 */
export function getEntitySchema(entityType) {
  return entitySchemas[entityType] || null
}

/**
 * Get all available entity types
 * @returns {string[]} Array of entity type keys
 */
export function getEntityTypes() {
  return Object.keys(entitySchemas)
}

/**
 * Get all entity schemas
 * @returns {Record<string, EntitySchema>} All entity schemas
 */
export function getAllSchemas() {
  return { ...entitySchemas }
}

/**
 * Validate entity data against schema
 * @param {string} entityType - Entity type
 * @param {Record<string, any>} data - Entity data to validate
 * @param {boolean} isNew - Whether this is a new entity (affects immutable field validation)
 * @returns {{valid: boolean, errors: string[]}} Validation result
 */
export function validateEntity(entityType, data, isNew = false) {
  const schema = getEntitySchema(entityType)
  if (!schema) {
    return { valid: false, errors: [`Unknown entity type: ${entityType}`] }
  }

  const errors = []

  // Check required fields
  for (const field of schema.fields) {
    if (field.required && !data[field.name]) {
      errors.push(`${field.label} is required`)
    }

    // Check custom validator
    if (field.validator && data[field.name]) {
      const validationResult = field.validator(data[field.name])
      if (validationResult !== true) {
        errors.push(validationResult)
      }
    }

    // Email validation
    if (field.type === 'email' && data[field.name]) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
      if (!emailRegex.test(data[field.name])) {
        errors.push(`${field.label} must be a valid email address`)
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  }
}

/**
 * Create default/empty entity data from schema
 * @param {string} entityType - Entity type
 * @returns {Record<string, any>} Default entity data
 */
export function createDefaultEntity(entityType) {
  const schema = getEntitySchema(entityType)
  if (!schema) {
    throw new Error(`Unknown entity type: ${entityType}`)
  }

  const entity = {}
  for (const field of schema.fields) {
    if (field.type === 'multiselect') {
      entity[field.name] = []
    } else if (field.type === 'checkbox') {
      entity[field.name] = false
    } else {
      entity[field.name] = ''
    }
  }

  return entity
}

export { entitySchemas }
