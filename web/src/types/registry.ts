export interface RegistryInfo {
	id: string;
	name: string;
	host: string;
	public: boolean;
	description: string;
	icon?: string;
}

export interface ImageSearchResult {
	name: string;
	description: string;
	stars: number;
	pulls: string;
	official: boolean;
	tags: string[];
	size?: string;
	architecture?: string[];
}

export interface ImageDetails {
	name: string;
	description: string;
	stars: number;
	pulls: string;
	size: string;
	architecture: string[];
	tags: Array<{
		name: string;
		size: string;
		lastUpdated: string;
		digest: string;
	}>;
	layers?: Array<{
		digest: string;
		size: string;
	}>;
}

export interface ImageTag {
	name: string;
	size: string;
	lastUpdated: string;
	digest: string;
}

export interface RegistrySearchResponse {
	registry: RegistryInfo;
	images: ImageSearchResult[];
	total: number;
}

export interface ImageDetailsResponse {
	registry: RegistryInfo;
	image: ImageDetails;
}

export interface ImageTagsResponse {
	image: string;
	tags: ImageTag[];
	total: number;
}
