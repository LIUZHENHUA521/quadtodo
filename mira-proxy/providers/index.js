import { createMiraProvider } from "./mira.js";
import { createTraeCnProvider } from "./trae-cn.js";

const PROVIDER_FACTORIES = {
	mira: createMiraProvider,
	"trae-cn": createTraeCnProvider,
};

export function getProvider(providerName, providerConfig) {
	const factory = PROVIDER_FACTORIES[providerName];
	if (!factory) {
		const supported = Object.keys(PROVIDER_FACTORIES).join(", ");
		throw new Error(
			`Unsupported provider: ${providerName}. Supported providers: ${supported}`,
		);
	}
	return factory(providerConfig);
}
