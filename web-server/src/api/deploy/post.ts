import { Operation } from "@staticdeploy/common-types";
import {
    BundleNotFoundError,
    validateEntrypointUrlMatcher
} from "@staticdeploy/storage";

import convroute from "common/convroute";
import IBaseRequest from "common/IBaseRequest";
import storage from "services/storage";

interface IRequest extends IBaseRequest {
    body: {
        appName: string;
        entrypointUrlMatcher: string;
        bundleNameTagCombination: string;
    };
}

const bodySchema = {
    type: "object",
    properties: {
        appName: { type: "string" },
        entrypointUrlMatcher: { type: "string" },
        bundleNameTagCombination: { type: "string" }
    },
    required: ["appName", "entrypointUrlMatcher", "bundleNameTagCombination"],
    additionalProperties: false
};

export default convroute({
    path: "/deploy",
    method: "post",
    description: "Deploy a bundle to an entrypoint",
    tags: ["deployments"],
    parameters: [
        {
            name: "deploymentOptions",
            in: "body",
            required: true,
            schema: bodySchema
        }
    ],
    responses: {
        "204": { description: "Bundle deployed to entrypoint" },
        "400": { description: "Body validation failed" },
        "404": { description: "Bundle not found" },
        "409": { description: "Entrypoint does not link to the app" }
    },
    handler: async (req: IRequest, res) => {
        // Retrieve the deploy objects
        const [bundle, existingApp, existingEntrypoint] = await Promise.all([
            storage.bundles.findLatestByNameTagCombination(
                req.body.bundleNameTagCombination
            ),
            storage.apps.findOneByIdOrName(req.body.appName),
            storage.entrypoints.findOneByIdOrUrlMatcher(
                req.body.entrypointUrlMatcher
            )
        ]);

        // Ensure the bundle exists
        if (!bundle) {
            throw new BundleNotFoundError(
                req.body.bundleNameTagCombination,
                "name:tag combination"
            );
        }

        // Ensure that, if the entrypoint exists, it links to the specified app
        // (which therefore must exist). Since we only need the entrypoint
        // reference for the deploy, we could ignore the app and deploy to that
        // entrypoint. However, this inconsistency is probably caused by a
        // user's mistake in calling the API, and so we prefer to respond with
        // an error.
        if (
            existingEntrypoint !== null &&
            (!existingApp || existingApp.id !== existingEntrypoint.appId)
        ) {
            res.status(409).send({
                message: `Entrypoint with urlMatcher = ${req.body.entrypointUrlMatcher} doesn't link to app with name = ${req.body.appName}`
            });
            return;
        }

        // Create the app if it doesn't exist
        let app = existingApp;
        if (!app) {
            // Validate the entrypointUrlMatcher to avoid creating the app if
            // the entrypoint creation will later fail (ideally we'd do both
            // operations in a transaction, but the storage module doesn't allow
            // us to do that)
            validateEntrypointUrlMatcher(req.body.entrypointUrlMatcher);

            app = await storage.apps.create({
                name: req.body.appName,
                defaultConfiguration: {}
            });

            await req.logOperation(Operation.createApp, { createdApp: app });
        }

        // Create the entrypoint if it doesn't exist
        let entrypoint = existingEntrypoint;
        if (!entrypoint) {
            entrypoint = await storage.entrypoints.create({
                appId: app.id,
                urlMatcher: req.body.entrypointUrlMatcher,
                configuration: null
            });

            await req.logOperation(Operation.createEntrypoint, {
                createdEntrypoint: entrypoint
            });
        }

        // Update the entrypoint to point it to the supplied bundle
        const newEntrypoint = await storage.entrypoints.update(entrypoint.id, {
            bundleId: bundle.id
        });

        await req.logOperation(Operation.updateEntrypoint, {
            oldEntrypoint: entrypoint,
            newEntrypoint: newEntrypoint
        });

        res.status(204).send();
    }
});
