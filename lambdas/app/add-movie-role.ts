import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { actorKey, ddb, movieKey, type Role, tableName } from "../shared/db";
import { isResponse, parseJsonObject, response } from "../shared/http";
import { logRequest } from "../shared/request-logger";


export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  logRequest(event);

  const body = parseJsonObject(event);
  if (isResponse(body)) return body;

  const invalid = [
    ...["movieId", "actorId"].filter(
      (field) => !Number.isInteger(body[field]) || (body[field] as number) <= 0
    ),
    ...["roleName", "roleDescription"].filter(
      (field) => typeof body[field] !== "string" || (body[field] as string).trim() === ""
    ),
  ];
  if (invalid.length) {
    return response(400, { message: `Missing or invalid fields: ${invalid.join(", ")}` });
  }

  const role: Role = {
    movieId: body.movieId as number,
    actorId: body.actorId as number,
    roleName: body.roleName as string,
    roleDescription: body.roleDescription as string,
  };

  try {
    const movie = movieKey(role.movieId);
    const actor = actorKey(role.actorId);
    // All or nothing: the movie and actor must exist, and the role must be new.
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: tableName,
              Key: { PK: movie, SK: movie },
              ConditionExpression: "attribute_exists(PK)",
            },
          },
          {
            ConditionCheck: {
              TableName: tableName,
              Key: { PK: actor, SK: actor },
              ConditionExpression: "attribute_exists(PK)",
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: { PK: movie, SK: actor, ...role },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
        ],
      })
    );
    return response(201, { message: "Role added", data: role });
  } catch (err) {
    if (err instanceof TransactionCanceledException) {
      // CancellationReasons are in the same order as TransactItems.
      const [movieMissing, actorMissing, roleExists] = (err.CancellationReasons ?? []).map(
        (reason) => reason.Code === "ConditionalCheckFailed"
      );
      if (movieMissing) {
        return response(404, { message: `Movie ${role.movieId} not found` });
      }
      if (actorMissing) {
        return response(404, { message: `Actor ${role.actorId} not found` });
      }
      if (roleExists) {
        return response(409, {
          message: `Actor ${role.actorId} already has a role in movie ${role.movieId}`,
        });
      }
    }
    console.error("DynamoDB error:", err);
    return response(500, {
      message: "Internal server error",
      error: err,
    });
  }
};
