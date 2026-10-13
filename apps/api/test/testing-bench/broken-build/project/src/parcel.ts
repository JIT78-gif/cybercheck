export interface Parcel {
  weightGrams: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}

const VOLUMETRIC_DIVISOR = 5000;

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive number, got ${value}`);
  }
}

export function volumetricWeightGrams(parcel: Parcel): number {
  assertPositive("lengthCm", parcel.lengthCm);
  assertPositive("widthCm", parcel.widthCm);
  assertPositive("heightCm", parcel.heightCm);
  return (parcel.lengthCm * parcel.widthCm * parcel.heightCm * 1000) / VOLUMETRIC_DIVISOR;
}

export function billableWeightGrams(parcel: Parcel): number {
  assertPositive("weightGrams", parcel.weightGrams);
  const heaviest = Math.max(parcel.weightGrams, volumetricWeightGrams(parcel));
  return Math.ceil(heaviest / 100) * 100;
}
