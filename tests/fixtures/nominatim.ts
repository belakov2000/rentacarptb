// Отговори на OpenStreetMap / Nominatim (format=jsonv2&addressdetails=1) за регресионните тестове на търсенето на адрес.
// Координатите, видът и адресните подробности са от реалния Nominatim (18.10.2026); подредбата е като в отговора.
export type Nom = { lat: string; lon: string; display_name: string; name: string; addresstype: string; place_rank: number; address: Record<string, string> };
export const nom = (lat: number, lon: number, addresstype: string, place_rank: number, name: string, address: Record<string, string>): Nom => ({
  lat: String(lat), lon: String(lon), addresstype, place_rank, name,
  display_name: [name, address.house_number, address.road, address.square, address.suburb, address.village || address.town || address.city, address.municipality, address.state, "България"].filter(Boolean).join(", "),
  address: { ...address, country: "България", country_code: "bg" },
});

// „гр. Пловдив, пл. Централен 1“: първият резултат е площад в с. Бяла река (общ. Първомай, обл. Пловдив) – оттам 49,8 км × 0,70 €.
// Нито един резултат не е пл. Централен в гр. Пловдив (музеят е на пл. Съединение, в район „Централен“).
export const CENTRAL_TRAP: Nom[] = [
  nom(42.058466, 25.2622624, "square", 25, "пл. Централен", { square: "пл. Централен", village: "Бяла река", municipality: "Първомай", state: "Пловдив" }),
  nom(42.1514332, 24.7452526, "tourism", 30, "Регионален исторически музей - Пловдив", { tourism: "Регионален исторически музей - Пловдив", house_number: "1", road: "площад Съединение", suburb: "Капана", city_district: "Централен", city: "Пловдив", state: "Пловдив" }),
  nom(42.3406738, 24.9976663, "square", 25, "Централен Площад", { square: "Централен Площад", village: "Отец Кирилово", municipality: "Брезово", state: "Пловдив" }),
];

// „бул. Дунав 10, Пловдив“ (структурирано търсене): само отсечки от булеварда – в OpenStreetMap няма сграда с №10.
// Първата отсечка (42.1618718, 24.7336781) е на ~66 м от точката на офиса в Google Maps.
export const DUNAV_10: Nom[] = [
  [42.1618718, 24.7336781, "Захарна фабрика"], [42.162434, 24.7388628, "Филипово"], [42.162972, 24.7465484, "Харман махала"], [42.1615328, 24.7299139, "Захарна фабрика"],
].map(([lat, lon, suburb]) => nom(lat as number, lon as number, "road", 26, "бул. Дунав", { road: "бул. Дунав", suburb: suburb as string, city_district: "Северен", city: "Пловдив", state: "Пловдив" }));

// „ул. Княз Александър I 42, Пловдив“ (структурирано търсене): сграда с №42 на ул. „Княз Александър I Батенберг“
export const KNYAZ_42: Nom[] = [
  nom(42.1447618, 24.7493222, "amenity", 30, "Макдоналдс", { amenity: "Макдоналдс", house_number: "42", road: "Княз Александър I Батенберг", suburb: "Капана", city_district: "Централен", city: "Пловдив", state: "Пловдив" }),
];

// „бул. Христо Ботев 82, Пловдив“: сграда с №82
export const BOTEV_82: Nom[] = [
  nom(42.1354659, 24.74957, "office", 30, "Регионална дирекция \"Автомобилна администрация\" - Пловдив", { office: "government", house_number: "82", road: "бул. Христо Ботев", suburb: "Военна болница", city_district: "Централен", city: "Пловдив", state: "Пловдив" }),
];
