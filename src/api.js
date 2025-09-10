export const API_URL = "http://localhost:3000/api/";

export function getApiEndpoint(path) {
	return `${API_URL}${path}`;
}
