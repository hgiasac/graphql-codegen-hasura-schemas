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
   *       models: ['user', 'role']
   * ```
   */
  models?: string[];
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
   * @description Disable fields that contain strings in the list
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
   *       disableFields: ["created_by", "updated_by", "_aggregate"]
   * ```
   */
  disableFields?: string[];

  /**
   * @description If the role doesn't has mutation permissions, the pk_columns_input type will be hidden. The plugin try to find primary key fields in the output model
   * @default ["id"]
   *
   * @exampleMarkdown
   * ```yaml {7}
   * schema: http://localhost:3000/graphql
   * generates:
   *   schema.graphql:
   *     plugins:
   *       - graphql-codegen-hasura-operations
   *     config:
   *       disableFields: ["created_by", "updated_by", "_aggregate"]
   * ```
   */
  primaryKeyNames?: string[];
};

export type ModelFieldSchema = {
  name: string;
  type: string;
  array: boolean;
  nullable: boolean;
};

export type ModelSchemas = {
  primaryKeys: ModelFieldSchema[];
  permissions: {
    get: boolean;
    insert: boolean;
    update: boolean;
    delete: boolean;
  };
  model: ModelFieldSchema[];
  insertInput: ModelFieldSchema[];
  setInput: ModelFieldSchema[];
};

type BuildModelSchemaOptions = {
  disableFields: string[];
  primaryKeyNames: string[];
};

export const plugin: PluginFunction<HasuraGraphQLConfig> = async (
  schema: GraphQLSchema,
  _documents,
  { models, disableFields, primaryKeyNames = ["id"] }
): Promise<string> => {
  return JSON.stringify(
    buildModelSchemas(models, schema, {
      disableFields,
      primaryKeyNames,
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
  models: string[],
  schema: GraphQLSchema,
  options: BuildModelSchemaOptions
): Record<string, ModelSchemas> => {
  const mutationFields = schema.getMutationType().getFields();

  return models.reduce((acc, modelName) => {
    const fieldName = snake(modelName);
    const fieldInsertInputName = snake(`${fieldName}_insert_input`);
    const fieldSetInputName = snake(`${fieldName}_set_input`);
    const deleteFieldName = `delete_${fieldName}`;
    const fieldPkColumnsName = snake(`${fieldName}_pk_columns_input`);

    const fieldNameCamelCase = camel(modelName);
    const fieldInsertInputNameCamelCase = camel(fieldInsertInputName);
    const fieldSetInputNameCamelCase = camel(fieldSetInputName);
    const deleteFieldNameCamelCase = camel(deleteFieldName);
    const fieldPkColumnsNameCamelCase = camel(fieldPkColumnsName);

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

    const pkInputType = (
      isInputObjectType(schema.getType(fieldPkColumnsName))
        ? schema.getType(fieldPkColumnsName)
        : schema.getType(fieldPkColumnsNameCamelCase)
    ) as GraphQLInputObjectType;

    const canDelete = Boolean(
      mutationFields[deleteFieldName] ??
        mutationFields[deleteFieldNameCamelCase]
    );

    const modelSchemas = isObjectType(modelType)
      ? buildModelSchema(modelType, options)
      : [];

    const insertInput = isInputObjectType(insertInputType)
      ? buildModelSchema(insertInputType, options)
      : [];

    const setInput = isInputObjectType(setInputType)
      ? buildModelSchema(setInputType, options)
      : [];

    const primaryKeys = isInputObjectType(pkInputType)
      ? buildModelSchema(pkInputType, options)
      : modelSchemas.filter((m) => options.primaryKeyNames.includes(m.name));
    
    const result: ModelSchemas = {
      primaryKeys,
      model: modelSchemas,
      insertInput,
      setInput,
      permissions: {
        get: modelSchemas.length > 0,
        insert: insertInput.length > 0,
        update: setInput.length > 0,
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
): ModelFieldSchema[] => {
  const fieldMap = modelType.getFields();
  return Object.keys(fieldMap).reduce((acc, key) => {
    if (
      options.disableFields?.some((disabledTerm) => key.includes(disabledTerm))
    ) {
      return acc;
    }

    const field = fieldMap[key];
    const schema = getInnerSchemaType(field.type, {
      name: key,
      type: null,
      array: false,
      nullable: true,
    });

    if (!schema) {
      return acc;
    }

    return [
      ...acc,
      schema,
    ];
  }, []);
};
