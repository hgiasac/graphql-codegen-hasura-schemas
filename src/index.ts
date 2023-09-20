import {
  PluginFunction,
  PluginValidateFn,
  Types,
} from "@graphql-codegen/plugin-helpers";
import {
  GraphQLSchema,
  isNonNullType,
  isObjectType,
  GraphQLObjectType,
  isInputObjectType,
  GraphQLInputObjectType,
  isListType,
  GraphQLType,
} from "graphql";
import { snake, camel } from "radash";

/**
 * @description This plugin prints the merged schema as string. If multiple schemas are provided, they will be merged and printed as one schema.
 */
export type HasuraGraphQLConfig = {
  /**
   * @description Set to true in order to print description as comments (using `#` instead of `"""`)
   * @default false
   *
   * @exampleMarkdown
   * ```yaml {7}
   * schema: http://localhost:3000/graphql
   * generates:
   *   schema.graphql:
   *     plugins:
   *       - graphql-codegen-hasura-schemas
   *     config:
   *       commentDescriptions: true
   * ```
   */
  commentDescriptions?: boolean;
  /**
   * @description Set the list of table for crud operations
   *
   * @exampleMarkdown
   * ```yaml {7}
   * schema: http://localhost:3000/graphql
   * generates:
   *   schema.graphql:
   *     plugins:
   *       - graphql-codegen-hasura-schemas
   *     config:
   *       tables: ['user', 'role']
   * ```
   */
  tables?: string[];
  /**
   * @description Set the max depth of nested objects
   * @default 1
   *
   * @exampleMarkdown
   * ```yaml {7}
   * schema: http://localhost:3000/graphql
   * generates:
   *   schema.graphql:
   *     plugins:
   *       - graphql-codegen-hasura-schemas
   *     config:
   *       maxDepth: 1
   * ```
   */
  maxDepth?: number;

  /**
   * @description Disable fields with aggregate suffixes
   * @default false
   *
   * @exampleMarkdown
   * ```yaml {7}
   * schema: http://localhost:3000/graphql
   * generates:
   *   schema.graphql:
   *     plugins:
   *       - graphql-codegen-hasura-schemas
   *     config:
   *       disableAggregateFields: true
   * ```
   */
  disableAggregateFields?: boolean;

  /**
   * @description Disable fields in the list
   * @default []
   *
   * @exampleMarkdown
   * ```yaml {7}
   * schema: http://localhost:3000/graphql
   * generates:
   *   schema.graphql:
   *     plugins:
   *       - graphql-codegen-hasura-operations
   *     config:
   *       disableFields: ["created_by", "updated_by"]
   * ```
   */
  disableFields?: string[];
};

type ModelFieldSchema = {
  type: string;
  array: boolean;
  nullable: boolean;
};

type ModelSchemas = {
  permissions: {
    insert: boolean;
    update: boolean;
    delete: boolean;
  };
  model: Record<string, ModelFieldSchema>;
  insertInput: Record<string, ModelFieldSchema>;
  setInput: Record<string, ModelFieldSchema>;
};

type BuildModelSchemaOptions = {
  disableAggregateFields: boolean;
  disableFields: string[];
};

export const plugin: PluginFunction<HasuraGraphQLConfig> = async (
  schema: GraphQLSchema,
  _documents,
  { tables, disableAggregateFields, disableFields }
): Promise<string> => {
  return JSON.stringify(
    buildModelSchemas(tables, schema, {
      disableAggregateFields,
      disableFields,
    })
  );
};

export const validate: PluginValidateFn<any> = async (
  _schema: GraphQLSchema,
  _documents: Types.DocumentFile[],
  _config: HasuraGraphQLConfig
) => {
  if (_config.maxDepth && _config.maxDepth <= 0) {
    throw new Error(`maxDepth must be larger than 0`);
  }
};

const buildModelSchemas = (
  tables: string[],
  schema: GraphQLSchema,
  options: BuildModelSchemaOptions
): Record<string, ModelSchemas> => {
  const mutationFields = schema.getMutationType().getFields();

  return tables.reduce((acc, modelName) => {
    const fieldName = snake(modelName);
    const fieldInsertInputName = snake(`${fieldName}_insert_input`);
    const fieldSetInputName = snake(`${fieldName}_set_input`);
    const deleteFieldName = `delete_${fieldName}`;

    const fieldNameCamelCase = camel(modelName);
    const fieldInsertInputNameCamelCase = camel(fieldInsertInputName);
    const fieldSetInputNameCamelCase = camel(fieldSetInputName);
    const deleteFieldNameCamelCase = camel(deleteFieldName);

    const modelType = (
      isObjectType(schema.getType(fieldName))
        ? schema.getType(fieldName)
        : schema.getType(fieldNameCamelCase)
    ) as GraphQLObjectType;

    const insertInputType = (
      isInputObjectType(schema.getType(fieldInsertInputName))
        ? schema.getType(fieldInsertInputName)
        : schema.getType(fieldInsertInputNameCamelCase)
    ) as GraphQLInputObjectType;

    const setInputType = (
      isInputObjectType(schema.getType(fieldSetInputName))
        ? schema.getType(fieldSetInputName)
        : schema.getType(fieldSetInputNameCamelCase)
    ) as GraphQLInputObjectType;

    const canDelete = Boolean(
      mutationFields[deleteFieldName] ??
        mutationFields[deleteFieldNameCamelCase]
    );

    const insertInput = isInputObjectType(insertInputType)
      ? buildModelSchema(insertInputType, options)
      : null;

    const setInput = isInputObjectType(setInputType)
      ? buildModelSchema(setInputType, options)
      : null;
    const result: ModelSchemas = {
      model: isObjectType(modelType)
        ? buildModelSchema(modelType, options)
        : null,
      insertInput,
      setInput,
      permissions: {
        insert: Boolean(insertInput),
        update: Boolean(setInput),
        delete: canDelete,
      },
    };

    if (!result.model && !result.insertInput && !result.setInput) {
      throw new Error(
        `model ${modelName} doesn't exist, or maybe the role doesn't have any permission`
      );
    }

    return {
      ...acc,
      [modelName]: result,
    };
  }, {});
};

const getInnerSchemaType = (
  gqlType: GraphQLType,
  schema: ModelFieldSchema
): ModelFieldSchema | null => {
  if (isNonNullType(gqlType)) {
    return getInnerSchemaType(gqlType.ofType, {
      ...schema,
      nullable: false,
    });
  }
  if (isObjectType(gqlType) || isInputObjectType(gqlType)) {
    return null;
  }

  if (isListType(gqlType)) {
    return getInnerSchemaType(gqlType.ofType, {
      ...schema,
      array: true,
    });
  }

  return {
    ...schema,
    type: gqlType.name,
  };
};

const buildModelSchema = (
  modelType: GraphQLObjectType | GraphQLInputObjectType,
  options: BuildModelSchemaOptions
): Record<string, ModelFieldSchema> => {
  const fieldMap = modelType.getFields();
  return Object.keys(fieldMap).reduce((acc, key) => {
    if (
      (options.disableAggregateFields && key.includes("_aggregate")) ||
      options.disableFields?.includes(key)
    ) {
      return acc;
    }

    const field = fieldMap[key];
    const schema = getInnerSchemaType(field.type, {
      type: null,
      array: false,
      nullable: true,
    });

    if (!schema) {
      return acc;
    }

    return {
      ...acc,
      [key]: schema,
    };
  }, {});
};
